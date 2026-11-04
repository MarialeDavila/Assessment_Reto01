import ExcelJS from "exceljs"
import PDFDocument from "pdfkit"
import { createWriteStream, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Mapeo } from "./mapeo"
import type { CampoPlantilla, Solicitud } from "./solicitud"

type Valor = { valor: string; estado: "lleno" | "faltante" | "requiere_confirmacion"; nota?: string }

export function indexar(m: Mapeo): Map<string, Valor> {
  const idx = new Map<string, Valor>()
  for (const c of m.llenos) idx.set(c.etiqueta, { valor: c.valor, estado: "lleno" })
  for (const c of m.requiere_confirmacion) idx.set(c.etiqueta, { valor: c.valor, estado: "requiere_confirmacion", nota: c.nota })
  for (const c of m.faltantes) idx.set(c.etiqueta, { valor: "", estado: "faltante", nota: c.motivo })
  return idx
}

/** P0: escribe cada etiqueta y su valor en la hoja y celda que indica plantilla-celdas.json. */
export async function generarXlsx(ruta: string, campos: CampoPlantilla[], m: Mapeo): Promise<void> {
  const idx = indexar(m)
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro como Proveedor"
  for (const c of campos) {
    const hoja = libro.getWorksheet(c.hoja ?? "Hoja1") ?? libro.addWorksheet(c.hoja ?? "Hoja1")
    hoja.getCell(c.celda_etiqueta ?? "A1").value = c.etiqueta
    hoja.getCell(c.celda_etiqueta ?? "A1").font = { bold: true }
    const v = idx.get(c.etiqueta)
    if (v && v.estado !== "faltante") hoja.getCell(c.celda_valor ?? "B1").value = v.valor
  }
  libro.eachSheet((h) => {
    h.columns.forEach((col) => (col.width = 36))
  })
  await libro.xlsx.writeFile(ruta)
}

/** P1: PDF generado que reproduce todos los campos, con etiqueta y valor, en el orden dado. */
export function generarPdf(ruta: string, s: Solicitud, campos: CampoPlantilla[], m: Mapeo): Promise<void> {
  const idx = indexar(m)
  return new Promise((res, rej) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Formulario de proveedor - ${s.cliente}` } })
    const flujo = createWriteStream(ruta)
    flujo.on("finish", () => res())
    flujo.on("error", rej)
    doc.pipe(flujo)
    doc.font("Helvetica-Bold").fontSize(14).text(`Formulario de registro de proveedor`)
    doc.font("Helvetica").fontSize(10).text(`Cliente: ${s.cliente} (${s.pais})   Solicitud: ${s.id}   Fecha: ${s.fecha}`).moveDown()
    for (const c of campos) {
      const v = idx.get(c.etiqueta)
      const marca = c.obligatorio ? " *" : ""
      const valor = !v || v.estado === "faltante" ? "(faltante: no existe en el repositorio maestro)" : v.estado === "requiere_confirmacion" ? `${v.valor}   [requiere confirmación]` : v.valor
      doc.font("Helvetica-Bold").text(`${c.etiqueta}${marca}: `, { continued: true }).font("Helvetica").text(valor)
      doc.moveDown(0.4)
    }
    doc.moveDown().fontSize(8).text("* Campo obligatorio. Documento preparado para revisión y firma del representante legal; no ha sido firmado ni enviado.")
    doc.end()
  })
}

/** P2: el portal no se automatiza; se dejan los valores listos para copiar. Nunca incluye credenciales. */
export function generarValoresPortal(ruta: string, s: Solicitud, campos: CampoPlantilla[], m: Mapeo): void {
  const idx = indexar(m)
  const filas = campos.map((c) => {
    const v = idx.get(c.etiqueta)
    const valor = !v || v.estado === "faltante" ? "**FALTANTE**" : v.valor
    const estado = v?.estado ?? "faltante"
    return `| ${c.etiqueta}${c.obligatorio ? " *" : ""} | ${valor} | ${estado}${v?.nota ? ` (${v.nota})` : ""} |`
  })
  const md = [
    `# Valores para el portal: ${s.cliente}`,
    "",
    "Formato no soportado para llenado automático (portal web). Copie estos valores en el portal.",
    "El ingreso de credenciales y el clic en \"Enviar\" los realiza una persona. Este archivo no contiene credenciales.",
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
    "\\* Campo obligatorio.",
  ].join("\n")
  writeFileSync(ruta, md + "\n")
}

export function generarReporteFaltantes(dir: string, s: Solicitud, m: Mapeo): string {
  const ruta = join(dir, "reporte-faltantes.md")
  const lineas = [
    `# Reporte de faltantes: ${s.cliente} (${s.id})`,
    "",
    `## Campos faltantes (${m.faltantes.length})`,
    ...(m.faltantes.length ? m.faltantes.map((f) => `- ${f.etiqueta}${f.obligatorio ? " (obligatorio)" : ""}: ${f.motivo}`) : ["- Ninguno."]),
    "",
    `## Campos que requieren confirmación (${m.requiere_confirmacion.length})`,
    ...(m.requiere_confirmacion.length ? m.requiere_confirmacion.map((f) => `- ${f.etiqueta}: valor propuesto "${f.valor}" (${f.ruta}). ${f.nota ?? ""}`) : ["- Ninguno."]),
  ]
  writeFileSync(ruta, lineas.join("\n") + "\n")
  return ruta
}
