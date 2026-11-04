import { z } from "zod"
import { fallo, leerJson, normalizar, ok, rutas, valorEnRuta, type Ctx, type Resultado } from "./lib"

export const ReglasSchema = z.object({
  identificador_tributario_por_pais: z.record(z.string()),
  pais_origen_maestro: z.string(),
  claves_identificador_tributario: z.array(z.string()),
  etiquetas_ambiguas: z.array(z.string()),
  claves_bancarias_prefijo: z.string(),
  umbral_confianza: z.number(),
  umbral_sugerencia: z.number(),
  nombres_soportes: z.record(z.string()),
})
export type Reglas = z.infer<typeof ReglasSchema>

export type CampoLleno = { etiqueta: string; ruta: string; valor: string; confianza: number; nota?: string }
export type CampoFaltante = { etiqueta: string; motivo: string; obligatorio?: boolean }
export type CampoPorConfirmar = CampoLleno & { propuesta?: string }
export type Mapeo = { llenos: CampoLleno[]; faltantes: CampoFaltante[]; requiere_confirmacion: CampoPorConfirmar[] }

type Base = { maestro: Record<string, unknown>; glosario: Record<string, string>; reglas: Reglas }

const VACIAS = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "en", "para", "proveedor"])

export function cargarBase(ctx: Ctx): Resultado<Base> {
  const r = rutas(ctx)
  const maestro = leerJson<Record<string, unknown>>(r.maestro, "el repositorio maestro (maestro.json)")
  if (!maestro.ok) return maestro
  const glosario = leerJson<Record<string, string>>(r.glosario, "el glosario de campos")
  if (!glosario.ok) return glosario
  const reglasRaw = leerJson(r.reglas, "las reglas de negocio (src/knowledge/reglas.json)")
  if (!reglasRaw.ok) return reglasRaw
  const reglas = ReglasSchema.safeParse(reglasRaw.data)
  if (!reglas.success) return fallo("Las reglas de negocio no tienen el formato esperado.")
  return ok({ maestro: maestro.data, glosario: glosario.data, reglas: reglas.data })
}

const tokens = (s: string) => new Set(normalizar(s).split(" ").filter((t) => t && !VACIAS.has(t)))

/** Coeficiente de Dice entre conjuntos de palabras: 1 = idénticas, 0 = sin palabras en común. */
function similitud(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return (2 * comunes) / (ta.size + tb.size)
}

function hojas(obj: unknown, prefijo = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return prefijo ? [prefijo] : []
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => hojas(v, prefijo ? `${prefijo}.${k}` : k))
}

type Candidato = { ruta: string; confianza: number; origen: string }

function buscarRuta(etiqueta: string, base: Base): Candidato | undefined {
  const exacta = base.glosario[etiqueta]
  if (exacta) return { ruta: exacta, confianza: 1, origen: "glosario" }
  const n = normalizar(etiqueta)
  const normal = Object.entries(base.glosario).find(([k]) => normalizar(k) === n)
  if (normal) return { ruta: normal[1], confianza: 0.95, origen: "glosario (normalizado)" }
  const opciones: Candidato[] = [
    ...Object.entries(base.glosario).map(([k, ruta]) => ({ ruta, confianza: similitud(etiqueta, k), origen: `glosario ("${k}")` })),
    ...hojas(base.maestro).map((ruta) => ({ ruta, confianza: similitud(etiqueta, ruta.replace(/[._]/g, " ")), origen: "clave del maestro" })),
  ]
  const mejor = opciones.sort((a, b) => b.confianza - a.confianza)[0]
  return mejor && mejor.confianza >= base.reglas.umbral_sugerencia ? { ...mejor, confianza: Math.round(mejor.confianza * 100) / 100 } : undefined
}

function texto(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "boolean") return v ? "Sí" : "No"
  if (typeof v === "string" || typeof v === "number") return String(v)
  return undefined
}

/** HU-2: cruza cada etiqueta con el maestro. Nunca inventa: sin fuente, el campo es faltante. */
export function mapear(etiquetas: string[], pais: string, base: Base, obligatorios: Map<string, boolean>): Mapeo {
  const m: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  const idPais = base.reglas.identificador_tributario_por_pais[pais]
  for (const etiqueta of etiquetas) {
    const obligatorio = obligatorios.get(etiqueta)
    const cand = buscarRuta(etiqueta, base)
    if (!cand) {
      m.faltantes.push({ etiqueta, motivo: "No existe un dato equivalente en el repositorio maestro.", obligatorio })
      continue
    }
    const valor = texto(valorEnRuta(base.maestro, cand.ruta))
    if (valor === undefined) {
      m.faltantes.push({ etiqueta, motivo: `La clave "${cand.ruta}" no tiene valor en el maestro.`, obligatorio })
      continue
    }
    const campo: CampoLleno = { etiqueta, ruta: cand.ruta, valor, confianza: cand.confianza }
    const esId = base.reglas.claves_identificador_tributario.includes(cand.ruta)
    if (base.reglas.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(etiqueta))) {
      m.requiere_confirmacion.push({ ...campo, propuesta: idPais, nota: `Etiqueta ambigua. Para ${pais} el equivalente es ${idPais ?? "desconocido"}.` })
    } else if (esId && pais !== base.reglas.pais_origen_maestro) {
      m.requiere_confirmacion.push({ ...campo, propuesta: idPais, nota: `identificador extranjero: el cliente (${pais}) pide ${idPais ?? etiqueta}; Periferia solo tiene NIT colombiano.` })
    } else if (cand.confianza < base.reglas.umbral_confianza) {
      m.requiere_confirmacion.push({ ...campo, nota: `Mapeo con confianza ${cand.confianza} por similitud con ${cand.origen}.` })
    } else {
      m.llenos.push(campo)
    }
  }
  return m
}
