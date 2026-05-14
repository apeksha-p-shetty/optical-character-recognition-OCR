
'use strict';

const { parseInvoice, printTable, buildTableText } = require('./parse-invoice');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

let _worker = null;

async function getWorker() {
  if (_worker) return _worker;

  _worker = await Tesseract.createWorker('eng', 1, {
    logger:      () => {},
    langPath:    './tessdata',
    cacheMethod: 'readWrite',
  });

  await _worker.setParameters({
    tessedit_pageseg_mode:     '3',
    tessedit_ocr_engine_mode:  '1',
    preserve_interword_spaces: '1',
    tessedit_do_invert:        '0',
    textord_heavy_nr:          '0',
  });

  process.on('exit', () => _worker?.terminate());
  return _worker;
}

async function preprocessInvoice(inputPath, outputPath) {
  const metadata = await sharp(inputPath).metadata();
  const targetWidth = Math.max(metadata.width || 0, 3000);

  const { data: pixels } = await sharp(inputPath)
    .grayscale()
    .resize({ width: 200 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mean = pixels.reduce((s, v) => s + v, 0) / pixels.length;
  const isDark = mean < 80;
  const isLowContrast = mean < 120 && !isDark;

  let pipeline = sharp(inputPath)
    .rotate()
    .resize({ width: targetWidth, withoutEnlargement: false })
    .grayscale();

  if (isDark) {
    pipeline = pipeline.negate().linear(1.1, -5);
  } else if (isLowContrast) {
    pipeline = pipeline.normalise().linear(1.1, -10);
  }

  await pipeline.png({ compressionLevel: 1 }).toFile(outputPath);
  return { mean, width: targetWidth };
}

function groupWordsIntoRows(words, yToleranceRatio = 0.6) {
  const filtered = words
    .filter(w => w.text?.trim() && w.confidence >= 45)
    .map(w => ({
      text:   w.text.trim(),
      conf:   w.confidence,
      x0:     w.bbox.x0,
      y0:     w.bbox.y0,
      x1:     w.bbox.x1,
      y1:     w.bbox.y1,
      height: w.bbox.y1 - w.bbox.y0,
    }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  if (!filtered.length) return [];

  const heights = filtered.map(w => w.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const yTolerance = medianHeight * yToleranceRatio;

  const rows = [];
  for (const w of filtered) {
    const last = rows[rows.length - 1];
    if (!last || w.y0 - last.y > yTolerance) {
      rows.push({ y: w.y0, words: [w] });
    } else {
      last.words.push(w);
      last.y = Math.min(last.y, w.y0);
    }
  }
  return rows;
}

function rowText(row) {
  return row.words
    .slice()
    .sort((a, b) => a.x0 - b.x0)
    .map(w => w.text)
    .join(' ')
    .trim();
}

function looksLikeItemRow(text) {
  const hasLeadingSerialNo = /^\d{1,2}\s+\S/.test(text);
  const hasDecimalAmount   = /\b\d{1,3}(?:,\d{3})*\.\d{2}\b/.test(text);
  const hasHsnCode         = /\b\d{4,8}\b/.test(text);
  return (hasLeadingSerialNo || hasHsnCode) && hasDecimalAmount;
}

function detectColumnZones(itemRows, imageWidth = 3000) {
  const srXs = [], hsnXs = [], qtyXs = [], totalXs = [];

  for (const row of itemRows) {
    const words = row.words.slice().sort((a, b) => a.x0 - b.x0);

    const srWord = words.find(w => /^\d{1,2}$/.test(w.text));
    if (srWord) srXs.push(srWord.x0);

    const hsnWord = words.find(w => /^\d{4,8}$/.test(w.text));
    if (hsnWord) hsnXs.push(hsnWord.x0);

    const qtyWord = words.find(w =>
      /^\d+(\.\d+)?\s*(KGS?|LTR|PCS|NOS|EA)?$/i.test(w.text)
    );
    if (qtyWord) qtyXs.push(qtyWord.x0);

    const amountWords = words.filter(w =>
      /\b\d{1,3}(?:,\d{3})*\.\d{2}\b/.test(w.text)
    );
    if (amountWords.length) totalXs.push(amountWords[amountWords.length - 1].x0);
  }

  const median = arr => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const tol = Math.round(imageWidth * 0.035);
  const band = (med, multiplier = 1) =>
    med !== null ? { min: med - tol * multiplier, max: med + tol * multiplier } : null;

  return {
    sr:    band(median(srXs),    0.8),
    hsn:   band(median(hsnXs),   1.0),
    qty:   band(median(qtyXs),   1.0),
    total: band(median(totalXs), 1.0),
  };
}

function parseItemRows(itemRows, imageWidth) {
  const zones = detectColumnZones(itemRows, imageWidth);
  const inZone = (zone, x) => zone && x >= zone.min && x <= zone.max;

  return itemRows.map(row => {
    const words = row.words.slice().sort((a, b) => a.x0 - b.x0);
    const rawText = rowText(row);

    let srNo = '', hsnSac = '', qty = '', rate = '', total = '';
    const descWords = [], amountBucket = [];

    for (const w of words) {
      if (inZone(zones.sr, w.x0) && /^\d{1,2}$/.test(w.text)) {
        srNo = w.text;
      } else if (inZone(zones.hsn, w.x0) && /^\d{4,8}$/.test(w.text)) {
        hsnSac = w.text;
      } else if (inZone(zones.qty, w.x0) && /^\d+(\.\d+)?\s*(KGS?|LTR|PCS|NOS|EA)?$/i.test(w.text)) {
        qty = w.text;
      } else if (inZone(zones.total, w.x0) && /\b\d{1,3}(?:,\d{3})*\.\d{2}\b/.test(w.text)) {
        total = w.text;
      } else if (/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/.test(w.text)) {
        amountBucket.push(w);
      } else if (w.text && !/^\d{1,2}$/.test(w.text)) {
        descWords.push(w);
      }
    }

    if (amountBucket.length) {
      const qtyCenter = zones.qty ? (zones.qty.min + zones.qty.max) / 2 : 0;
      amountBucket.sort((a, b) => Math.abs(a.x0 - qtyCenter) - Math.abs(b.x0 - qtyCenter));
      rate = amountBucket[0].text;
    }

    return {
      raw:         rawText,
      srNo,
      description: descWords.map(w => w.text).join(' ').trim(),
      hsnSac,
      qty,
      rate,
      total,
    };
  });
}

function correctOcrErrors(text) {
  return text
    .replace(/(?<=\d)O(?=\d)/g, '0')
    .replace(/(?<=\d)l(?=\d)/g,  '1')
    .replace(/(?<=\d)I(?=\d)/g,  '1')
    .replace(/(?<=\s)S(?=\d)/g,  '5')
    .replace(/Rs\.?\s*/g, '₹')
    .replace(/INR\s*/g,   '₹');
}

function extractBillFields(text) {
  const find = pattern => {
    const m = text.match(pattern);
    return m ? (m[1] || m[0]).trim() : null;
  };

  return {
    total: find(
      /(?:final\s*amount|total\s*amount\s*after\s*tax|grand\s*total|net\s*payable|amount\s*due)[^\d₹]*[₹\s]*(\d[\d,]*\.?\d*)/i
    ),
    taxableAmount: find(
      /(?:sub\s*total|taxable\s*amount|subtotal)[^\d₹]*[₹\s]*(\d[\d,]*\.?\d*)/i
    ),
    discount: find(
      /(?:discount)[^\d₹]*[₹\s]*(\d[\d,]*\.?\d*)/i
    ),
    gst: find(
      /(?:add\s*:?\s*igst|add\s*:?\s*gst|total\s*tax|igst\s*amount|gst\s*amount)[^\d₹]*[₹\s]*(\d[\d,]*\.?\d*)/i
    ),
    date: find(
      /(?:invoice\s*date|bill\s*date|date)[^\d]*(\d{1,2}[\/\-\.]\w{2,3}[\/\-\.]\d{2,4})/i
    ) || find(/\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/),
    invoiceNo: find(
      /(?:invoice\s*no\.?|bill\s*no\.?|receipt\s*no\.?)[^\w]*([A-Z0-9\-\/]{1,20})/i
    ),
    gstin: find(
      /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])\b/
    ),
    customerName: find(
      /(?:name\s*[:\|]?\s*)([A-Za-z][A-Za-z\s]{2,40})/i
    ),
    vendor: text.split('\n')
      .map(l => l.trim())
      .find(l => l.length > 4 && /[A-Za-z]/.test(l)) || null,
  };
}

async function ocrInvoice(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const processedPath = path.join(
    path.dirname(inputPath),
    `processed_${Date.now()}_${process.pid}.png`
  );

  try {
    const { width: imageWidth, mean } = await preprocessInvoice(inputPath, processedPath);
    console.error(`[pre] brightness: ${mean.toFixed(1)}, width: ${imageWidth}px`);

    const worker = await getWorker();
    const { data } = await worker.recognize(processedPath);

    const rows     = groupWordsIntoRows(data.words || []);
    const lines    = rows.map(rowText).filter(Boolean);
    const itemRows = rows.filter(r => looksLikeItemRow(rowText(r)));
    const items    = parseItemRows(itemRows, imageWidth);

    const correctedText = correctOcrErrors(data.text || '');
    const fields        = extractBillFields(correctedText);

    const avgConf = data.words?.length
      ? data.words.reduce((s, w) => s + w.confidence, 0) / data.words.length
      : 0;

    const output = {
      fields,
      items,
      lines,
      fullText: correctedText,
      meta: {
        imageWidth,
        wordCount:     data.words?.length || 0,
        avgConfidence: Math.round(avgConf * 10) / 10,
        itemRowsFound: itemRows.length,
      },
    };

    fs.writeFileSync('invoice_output.json', JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));

    // ── AI PARSING ──────────────────────────────────────
    console.error('[ai] Sending to Groq...');
    try {
      const invoice = await parseInvoice(output.fullText, inputPath);
      console.error('[ai] Groq returned:', JSON.stringify(invoice, null, 2));
      const tableText = buildTableText(invoice);
      console.log(tableText);
      fs.writeFileSync('invoice_output.txt', tableText);
      console.error('[ai] Saved table to invoice_output.txt');
    } catch (err) {
      console.error('[ai] Parsing failed:', err.message);
      fs.writeFileSync('invoice_output.txt', output.fullText);
    }
    // ────────────────────────────────────────────────────

    return output;

  } finally {
    if (fs.existsSync(processedPath)) fs.unlinkSync(processedPath);
  }
}

const inputFile = process.argv[2] || 'sample7.png';
ocrInvoice(inputFile).catch(err => {
  console.error('OCR failed:', err.message);
  process.exit(1);
});