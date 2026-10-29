// Builds the Push–Pull Policy Dialogue programme as an A4 Word document.
// Run from this folder: node build.js
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  Footer, AlignmentType, WidthType, BorderStyle, ShadingType, VerticalAlign,
  TableLayoutType, HeightRule,
} = require("docx");

const asset = (f) => fs.readFileSync(path.join(__dirname, "assets", f));

const GREEN = "1F4D2B";
const GOLD = "B8902F";
const INK = "222222";
const MUTED = "6B6B6B";
const BREAK_FILL = "F5EEDC";
const ROW_ALT = "F7F9F6";

const HEAD_FONT = "Cambria";
const BODY_FONT = "Calibri";

// A4 portrait, 1.5 cm side margins
const PAGE_W = 11906;
const MARGIN_X = 850;
const CONTENT_W = PAGE_W - 2 * MARGIN_X; // 10206
const COLS = [1600, 5406, 3200];

const TBC = "To be confirmed";

// [time, session runs, speaker runs, kind]
// kind: "break" for tea/meals, otherwise undefined
const agenda = [
  ["08:30–08:45", [["Registration"]], [["Organisers"]]],
  ["08:45–09:00", [["Welcome address"]], [["Ato Ghebremedhin"]]],
  ["09:00–09:15", [["Opening remarks"]], [["Dr. Tadele"]]],
  ["09:15–09:30", [["Introduction of participants"]], [["All participants"]]],
  ["09:30–10:30",
    [["Presentation: ", "b"], ["Push–pull technology for sorghum production — policy implications and scaling priorities"]],
    [["Dr. Getnet"]]],
  ["10:30–11:00", [["Tea and health break"]], [["Organisers"]], "break"],
  ["11:00–12:30",
    [["Questions, answers and plenary discussion on the sorghum presentation"]],
    [["All participants"], ["Facilitator: ", "br"], [TBC, "tbc"]]],
  ["12:30–14:00", [["Lunch break"]], [["Organisers"]], "break"],
  ["14:00–14:30",
    [["Summary of the morning discussions and key issues raised"]],
    [["Facilitator: "], [TBC, "tbc"]]],
  ["14:30–15:30",
    [["Presentation: ", "b"], ["Push–pull technology for maize production — policy implications and scaling priorities"]],
    [["Speaker: "], [TBC, "tbc"]]],
  ["15:30–16:00", [["Tea and health break"]], [["Organisers"]], "break"],
  ["16:00–17:30",
    [["Questions, answers and plenary discussion on the maize presentation"]],
    [["All participants"], ["Facilitator: ", "br"], [TBC, "tbc"]]],
  ["17:30–18:00",
    [["Synthesis of the dialogue, key conclusions and closing remarks"]],
    [["Dr. Tadele"]]],
  ["18:30 onwards", [["Dinner with participants"]], [["Organisers"]], "break"],
];

const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const rule = { style: BorderStyle.SINGLE, size: 4, color: "D9D4C7" };

function runs(parts, isBreak) {
  return parts.map(([text, style]) => new TextRun({
    text,
    font: BODY_FONT,
    size: 21,
    bold: style === "b",
    italics: style === "tbc" || isBreak,
    color: style === "tbc" ? MUTED : (isBreak ? "7A5C1A" : INK),
    break: style === "br" ? 1 : undefined,
  }));
}

function cell(children, width, fill, opts = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    borders: { top: noBorder, left: noBorder, right: noBorder, bottom: opts.bottom || rule },
    children,
  });
}

const headerRow = new TableRow({
  tableHeader: true,
  height: { value: 520, rule: HeightRule.ATLEAST },
  children: ["Time", "Session / Activity", "Speaker / Responsible Person"].map((h, i) =>
    cell([new Paragraph({ children: [new TextRun({ text: h.toUpperCase(), font: BODY_FONT, size: 17, bold: true, color: "FFFFFF", characterSpacing: 20 })] })],
      COLS[i], GREEN, { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD } })),
});

const bodyRows = agenda.map(([time, session, speaker, kind], idx) => {
  const isBreak = kind === "break";
  const fill = isBreak ? BREAK_FILL : (idx % 2 ? ROW_ALT : undefined);
  return new TableRow({
    cantSplit: true,
    children: [
      cell([new Paragraph({ children: [new TextRun({ text: time, font: BODY_FONT, size: 21, bold: true, color: isBreak ? "7A5C1A" : GREEN })] })], COLS[0], fill),
      cell([new Paragraph({ children: runs(session, isBreak) })], COLS[1], fill),
      cell([new Paragraph({ children: runs(speaker, isBreak) })], COLS[2], fill),
    ],
  });
});

const agendaTable = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: COLS,
  layout: TableLayoutType.FIXED,
  borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
  rows: [headerRow, ...bodyRows],
});

// Banner header: 2000 x 544 source, full content width (≈ 680 px at 96 dpi)
const BANNER_W = 680;
const banner = new Paragraph({
  spacing: { after: 160 },
  children: [new ImageRun({ type: "jpg", data: asset("header.jpg"), transformation: { width: BANNER_W, height: Math.round(BANNER_W * 544 / 2000) } })],
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 0 } },
});

const titleBlock = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 20 },
    children: [new TextRun({ text: "Push–Pull Technology Policy Dialogue", font: HEAD_FONT, size: 40, bold: true, color: GREEN })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [new TextRun({ text: "Sorghum and Maize Production Systems", font: HEAD_FONT, size: 26, italics: true, color: INK })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    children: [
      new TextRun({ text: "Monday, 9 November 2026", font: BODY_FONT, size: 21, bold: true, color: INK }),
      new TextRun({ text: "   •   ", font: BODY_FONT, size: 21, color: GOLD, bold: true }),
      new TextRun({ text: "Adulala Resort, Bishoftu, Ethiopia", font: BODY_FONT, size: 21, bold: true, color: INK }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: "Event period 8–10 November 2026, including arrival and departure", font: BODY_FONT, size: 17, italics: true, color: MUTED })],
  }),
  new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text: "PROGRAMME", font: BODY_FONT, size: 20, bold: true, color: GOLD, characterSpacing: 60 })],
  }),
];

const legend = new Paragraph({
  spacing: { before: 100 },
  children: [
    new TextRun({ text: "■ ", font: BODY_FONT, size: 17, color: "E3D3A6" }),
    new TextRun({ text: "Shaded rows indicate tea breaks and meals.", font: BODY_FONT, size: 16, italics: true, color: MUTED }),
  ],
});

// Footer: the three partner logos at equal height, evenly spaced
const LOGO_H = 62;
const logos = [
  ["logo-isd.png", 740, 408],
  ["logo-icipe.png", 900, 416],
  ["logo-biovision.png", 488, 424],
];
const footerCellW = Math.floor(CONTENT_W / 3);
const footerTable = new Table({
  width: { size: footerCellW * 3, type: WidthType.DXA },
  columnWidths: [footerCellW, footerCellW, footerCellW],
  layout: TableLayoutType.FIXED,
  borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
  rows: [new TableRow({
    children: logos.map(([f, w, h]) => new TableCell({
      width: { size: footerCellW, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: "png", data: asset(f), transformation: { width: Math.round(LOGO_H * w / h), height: LOGO_H } })],
      })],
    })),
  })],
});

const doc = new Document({
  creator: "Institute for Sustainable Development (ISD), Ethiopia",
  title: "Push–Pull Technology Policy Dialogue — Programme",
  styles: { default: { document: { run: { font: BODY_FONT, size: 19 } } } },
  sections: [{
    properties: {
      page: {
        size: { width: PAGE_W, height: 16838 },
        margin: { top: 567, bottom: 1500, left: MARGIN_X, right: MARGIN_X, header: 400, footer: 340 },
      },
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({ spacing: { after: 100 }, border: { top: { style: BorderStyle.SINGLE, size: 8, color: GOLD, space: 1 } }, children: [] }),
          footerTable,
        ],
      }),
    },
    children: [banner, ...titleBlock, agendaTable, legend],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const out = path.join(__dirname, "PushPull_Policy_Dialogue_Programme.docx");
  fs.writeFileSync(out, buf);
  console.log("Wrote", out);
});
