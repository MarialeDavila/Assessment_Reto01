import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { asegurarDir, dentroDe, fechaEjecucion, leerJson, rutas, type Ctx } from "./lib"
import type { Mapeo, Reglas } from "./mapeo"
import type { Caso } from "./solicitud"

const IndiceSchema = z.array(z.object({ tipo: z.string(), archivo: z.string(), vigencia_hasta: z.string().nullable(), pais_emisor: z.string(), descripcion: z.string().optional() }))

export type EstadoSoporte = { tipo: string; nombre: string; estado: "presente" | "ausente" | "vencido"; archivo?: string; vigencia_hasta?: string | null; pais_emisor?: string }
export type Checklist = {
  fecha_ejecucion: string
  soportes: EstadoSoporte[]
  campos_faltantes: string[]
  campos_por_confirmar: string[]
  bloqueos: string[]
  observaciones: string[]
}

/** RN3: vencido o ausente bloquea; un campo faltante no bloquea pero se lista. */
export function evaluarSoportes(ctx: Ctx, caso: Caso, reglas: Reglas): { soportes: EstadoSoporte[]; error?: string } {
  const r = rutas(ctx)
  const idx = leerJson(join(r.soportes, "index.json"), "el índice de soportes (index.json)")
  const indice = idx.ok ? IndiceSchema.safeParse(idx.data) : undefined
  const hoy = fechaEjecucion()
  const lista = indice?.success ? indice.data : []
  const soportes = caso.soportes.map((tipo): EstadoSoporte => {
    const nombre = reglas.nombres_soportes[tipo] ?? tipo
    const s = lista.find((x) => x.tipo === tipo)
    if (!s || !existsSync(join(r.soportes, s.archivo))) return { tipo, nombre, estado: "ausente" }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < hoy
    return { tipo, nombre, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta, pais_emisor: s.pais_emisor }
  })
  return { soportes, error: idx.ok && indice?.success ? undefined : "El índice de soportes no se pudo leer; todos los soportes se reportan como ausentes." }
}

export function construirChecklist(ctx: Ctx, caso: Caso, m: Mapeo, reglas: Reglas): Checklist {
  const ev = evaluarSoportes(ctx, caso, reglas)
  const bloqueos = ev.soportes.filter((s) => s.estado !== "presente").map((s) => `${s.nombre}: ${s.estado}${s.vigencia_hasta ? ` (vigencia hasta ${s.vigencia_hasta})` : ""}`)
  const observaciones: string[] = []
  if (ev.error) observaciones.push(ev.error)
  if (caso.errorPlantilla) observaciones.push(caso.errorPlantilla)
  if (caso.solicitud.formato === "portal") observaciones.push("Formato portal: no se llena automáticamente; ver valores-portal.md.")
  const extranjeros = ev.soportes.filter((s) => s.pais_emisor && s.pais_emisor !== caso.solicitud.pais)
  if (extranjeros.length) observaciones.push(`Soportes emitidos en ${extranjeros[0]?.pais_emisor} para un cliente de ${caso.solicitud.pais}: confirmar si el cliente los acepta.`)
  return {
    fecha_ejecucion: fechaEjecucion(),
    soportes: ev.soportes,
    campos_faltantes: m.faltantes.map((f) => f.etiqueta),
    campos_por_confirmar: m.requiere_confirmacion.map((f) => f.etiqueta),
    bloqueos,
    observaciones,
  }
}

function checklistMd(caso: Caso, c: Checklist, listo: boolean): string {
  const marca = (e: EstadoSoporte["estado"]) => (e === "presente" ? "[x]" : "[ ]")
  return [
    `# Checklist del paquete: ${caso.solicitud.cliente} (${caso.solicitud.id})`,
    "",
    `Fecha de ejecución: ${c.fecha_ejecucion}`,
    `Estado: **${listo ? "listo_para_firma" : "bloqueado"}**`,
    "",
    "## Soportes exigidos",
    ...c.soportes.map((s) => `- ${marca(s.estado)} ${s.nombre}: **${s.estado}**${s.vigencia_hasta ? ` (vigencia hasta ${s.vigencia_hasta})` : ""}`),
    "",
    "## Campos faltantes (no bloquean)",
    ...(c.campos_faltantes.length ? c.campos_faltantes.map((f) => `- ${f}`) : ["- Ninguno."]),
    "",
    "## Campos que requieren confirmación",
    ...(c.campos_por_confirmar.length ? c.campos_por_confirmar.map((f) => `- ${f}`) : ["- Ninguno."]),
    "",
    "## Bloqueos",
    ...(c.bloqueos.length ? c.bloqueos.map((b) => `- ${b}`) : ["- Ninguno."]),
    ...(c.observaciones.length ? ["", "## Observaciones", ...c.observaciones.map((o) => `- ${o}`)] : []),
  ].join("\n") + "\n"
}

/** RN2: el borrador nunca incluye datos bancarios. */
function correoMd(caso: Caso, adjuntos: string[]): string {
  const s = caso.solicitud
  return [
    `**Para:** ${s.de}`,
    `**Asunto:** RE: ${s.asunto}`,
    "",
    "Estimados señores:",
    "",
    `En atención a su solicitud del ${s.fecha}, remitimos la documentación para el registro de Periferia IT Group como proveedor de ${s.cliente}.`,
    "",
    "Adjuntos:",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "Área Administrativa, Periferia IT Group",
    "",
    "---",
    "_Borrador preparado por el agente. Pendiente de revisión y firma del representante legal. No ha sido enviado._",
  ].join("\n") + "\n"
}

export function escribirPaquete(ctx: Ctx, caso: Caso, c: Checklist, formulario: string | undefined): { ruta: string; listo: boolean } {
  const r = rutas(ctx, caso.solicitud.id)
  const dir = join(r.salida, "paquete")
  if (dentroDe(r.out, dir)) rmSync(dir, { recursive: true, force: true })
  asegurarDir(dir)
  const adjuntos: string[] = []
  if (formulario && existsSync(formulario)) {
    const nombre = formulario.split(/[\\/]/).pop() ?? "formulario"
    copyFileSync(formulario, join(dir, nombre))
    adjuntos.push(nombre)
  }
  for (const s of c.soportes) {
    if (!s.archivo) continue
    copyFileSync(join(r.soportes, s.archivo), join(dir, s.archivo))
    if (s.estado === "presente") adjuntos.push(s.archivo)
  }
  const listo = c.bloqueos.length === 0
  writeFileSync(join(dir, "checklist.md"), checklistMd(caso, c, listo))
  writeFileSync(join(dir, "borrador-correo.md"), correoMd(caso, adjuntos))
  writeFileSync(join(r.salida, "estado.json"), JSON.stringify({ caso: caso.solicitud.id, listo_para_firma: listo, checklist: c, adjuntos }, null, 2))
  return { ruta: dir, listo }
}
