type XlsxValue = string | number | boolean;

type XlsxRow = Array<{ value: XlsxValue; kind?: "date" | "number" | "header" }>;

const textEncoder = new TextEncoder();

function xml(value: string) {
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || code >= 32 ? character : "";
  }).join("");
  return printable
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bytes(value: string) {
  return textEncoder.encode(value);
}

function littleEndian(value: number, size: 2 | 4) {
  const result = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) result[index] = (value >>> (index * 8)) & 0xff;
  return result;
}

function joinBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; content: string }>) {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = bytes(file.name);
    const content = bytes(file.content);
    const crc = crc32(content);
    const local = joinBytes([
      littleEndian(0x04034b50, 4), littleEndian(20, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(crc, 4), littleEndian(content.length, 4),
      littleEndian(content.length, 4), littleEndian(name.length, 2), littleEndian(0, 2), name, content,
    ]);
    parts.push(local);
    directory.push(joinBytes([
      littleEndian(0x02014b50, 4), littleEndian(20, 2), littleEndian(20, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(crc, 4), littleEndian(content.length, 4),
      littleEndian(content.length, 4), littleEndian(name.length, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 4), littleEndian(offset, 4), name,
    ]));
    offset += local.length;
  }
  const centralDirectory = joinBytes(directory);
  return joinBytes([
    ...parts,
    centralDirectory,
    littleEndian(0x06054b50, 4), littleEndian(0, 2), littleEndian(0, 2), littleEndian(files.length, 2),
    littleEndian(files.length, 2), littleEndian(centralDirectory.length, 4), littleEndian(offset, 4), littleEndian(0, 2),
  ]);
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function excelDate(value: string) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000) + 25_569;
}

function cell(address: string, entry: XlsxRow[number]) {
  if (entry.kind === "date") return `<c r="${address}" s="1"><v>${excelDate(String(entry.value))}</v></c>`;
  if (entry.kind === "number" || typeof entry.value === "number") return `<c r="${address}"><v>${entry.value}</v></c>`;
  const style = entry.kind === "header" ? ' s="2"' : "";
  return `<c r="${address}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(entry.value))}</t></is></c>`;
}

export function createWaitingTimeWorkbook(rows: XlsxRow[]) {
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((entry, columnIndex) => cell(`${columnName(columnIndex)}${rowIndex + 1}`, entry)).join("")}</row>`).join("");
  return zip([
    { name: "[Content_Types].xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: "_rels/.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Waiting time" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: "xl/styles.xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF78113D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>' },
    { name: "xl/worksheets/sheet1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="2" width="14" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="6" width="15" customWidth="1"/><col min="7" max="8" width="32" customWidth="1"/><col min="9" max="11" width="20" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:K${Math.max(rows.length, 1)}"/></worksheet>` },
  ]);
}
