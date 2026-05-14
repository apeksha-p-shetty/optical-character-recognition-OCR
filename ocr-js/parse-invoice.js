// parse-invoice.js
const https = require("https");
const fs = require("fs");

const GROQ_API_KEY = "YOUR_API_KEY";

async function parseInvoice(ocrText, imagePath = null) {
  let messages;

  if (imagePath && fs.existsSync(imagePath)) {
    // Vision mode — send image directly to Groq
    const imageData = fs.readFileSync(imagePath).toString("base64");
    const ext = imagePath.split(".").pop().toLowerCase();
    const mimeType = ext === "png" ? "image/png" : "image/jpeg";

    console.error("[ai] Using vision mode — sending image directly");

    messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageData}`,
            },
          },
          {
            type: "text",
            text: `Extract all invoice data from this image and return ONLY valid JSON. No markdown, no explanation, no code blocks — just raw JSON.

Return exactly this structure:
{
  "store_name": "",
  "store_address": "",
  "gstin": "",
  "invoice_no": "",
  "invoice_date": "",
  "delivery_date": "",
  "customer_name": "",
  "customer_phone": "",
  "customer_address": "",
  "items": [
    {
      "sr_no": 1,
      "description": "",
      "hsn": "",
      "qty": "",
      "rate": 0,
      "taxable_value": 0,
      "tax_percent": 0,
      "tax_amount": 0,
      "total": 0
    }
  ],
  "subtotal": 0,
  "discount": 0,
  "total_tax": 0,
  "grand_total": 0,
  "total_in_words": ""
}

Rules:
- Read ALL text including colored/highlighted rows
- Remove rupee symbol from numbers, keep only numeric value as float
- "Sub Total" or "SubTotal" = subtotal field
- "Final Amount" or "Grand Total" = grand_total field
- "Discount" = discount field
- GST % column means tax_percent per item
- Numbers must be floats, not strings
- Missing fields use null`,
          },
        ],
      },
    ];
  } else {
    // Fallback — text only mode
    console.error("[ai] Using text mode — no image provided");
    messages = [
      {
        role: "system",
        content: `You are an invoice data extractor.
Given messy OCR text from an invoice, extract all data and return ONLY valid JSON.
No markdown, no explanation, no code blocks — just raw JSON.

Return exactly this structure:
{
  "store_name": "",
  "store_address": "",
  "gstin": "",
  "invoice_no": "",
  "invoice_date": "",
  "delivery_date": "",
  "customer_name": "",
  "customer_phone": "",
  "customer_address": "",
  "items": [
    {
      "sr_no": 1,
      "description": "",
      "hsn": "",
      "qty": "",
      "rate": 0,
      "taxable_value": 0,
      "tax_percent": 0,
      "tax_amount": 0,
      "total": 0
    }
  ],
  "subtotal": 0,
  "discount": 0,
  "total_tax": 0,
  "grand_total": 0,
  "total_in_words": ""
}

Rules:
- Fix OCR errors (e.g. "T1LTR" = "1 LTR")
- Remove rupee symbol from numbers, keep only numeric value as float
- "Sub Total" or "SubTotal" = subtotal field
- "Final Amount" or "Grand Total" = grand_total field
- "Discount" = discount field
- GST % column means tax_percent per item
- Numbers must be floats, not strings
- Missing fields use null`,
      },
      {
        role: "user",
        content: "Extract invoice data from this OCR text:\n\n" + ocrText,
      },
    ];
  }

  const body = JSON.stringify({
    model: "meta-llama/llama-4-scout-17b-16e-instruct", // vision model
    messages,
    temperature: 0.1,
    max_tokens: 2048,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.groq.com",
        path: "/openai/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + GROQ_API_KEY,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const response = JSON.parse(data);
            if (response.error) return reject(new Error("Groq error: " + response.error.message));
            let text = response.choices[0].message.content;
            text = text.replace(/```json|```/gi, "").trim();
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error("Parse failed: " + e.message + "\nRaw: " + data));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildTableText(invoice) {
  const lines = [];
  const SEP  = "=".repeat(100);
  const THIN = "-".repeat(100);

  lines.push(SEP);
  lines.push("  STORE   : " + (invoice.store_name    || "N/A"));
  lines.push("  ADDRESS : " + (invoice.store_address  || "N/A"));
  lines.push("  GSTIN   : " + (invoice.gstin          || "N/A"));
  lines.push("  INV NO  : " + (invoice.invoice_no     || "N/A") + "   DATE: " + (invoice.invoice_date || "N/A"));
  lines.push("  DELIVERY: " + (invoice.delivery_date  || "N/A"));
  lines.push(THIN);
  lines.push("  CUSTOMER: " + (invoice.customer_name    || "N/A"));
  lines.push("  PHONE   : " + (invoice.customer_phone   || "N/A"));
  lines.push("  ADDRESS : " + (invoice.customer_address || "N/A"));
  lines.push(SEP);

  lines.push(
    "  " +
    col("#",           4)  +
    col("Description", 36) +
    col("HSN",         8)  +
    col("Qty",         8)  +
    colR("Rate",     10)   +
    colR("Taxable",  10)   +
    colR("Tax%",      6)   +
    colR("Tax",      10)   +
    colR("Total",    10)
  );
  lines.push("  " + "-".repeat(102));

  (invoice.items || []).forEach((item) => {
    lines.push(
      "  " +
      col(item.sr_no,                             4)  +
      col((item.description || "").slice(0, 34), 36) +
      col(item.hsn,                               8)  +
      col(item.qty,                               8)  +
      colR(fmt(item.rate),                       10)  +
      colR(fmt(item.taxable_value),              10)  +
      colR(item.tax_percent != null ? item.tax_percent + "%" : "—", 6) +
      colR(fmt(item.tax_amount),                 10)  +
      colR(fmt(item.total),                      10)
    );
  });

  lines.push("  " + "-".repeat(102));
  lines.push("  " + " ".repeat(76) + "Subtotal : " + fmt(invoice.subtotal).padStart(10));

  if (invoice.discount && invoice.discount !== 0) {
    lines.push("  " + " ".repeat(76) + "Discount : " + fmt(invoice.discount).padStart(10));
  }

  lines.push("  " + " ".repeat(76) + "Tax      : " + fmt(invoice.total_tax).padStart(10));
  lines.push("  " + " ".repeat(76) + "TOTAL    : " + fmt(invoice.grand_total).padStart(10));
  lines.push(SEP);

  if (invoice.total_in_words) {
    lines.push("  In Words : " + invoice.total_in_words);
  }

  lines.push(SEP);
  return lines.join("\n");
}

function printTable(invoice) {
  console.log(buildTableText(invoice));
}

function col(val, len)  { return String(val ?? "—").padEnd(len); }
function colR(val, len) { return String(val ?? "—").padStart(len); }
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(2);
}

module.exports = { parseInvoice, printTable, buildTableText };