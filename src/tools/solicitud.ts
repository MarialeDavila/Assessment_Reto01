import { z } from "zod"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fallo, leerJson, ok, type Resultado } from "./lib"

export const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

const CeldaSchema = z.object({ hoja: z.string(), celda_etiqueta: z.string().regex(/^[A-Z]{1,3}\d{1,6}$/), etiqueta: z.string(), celda_valor: z.string().regex(/^[A-Z]{1,3}\d{1,6}$/) })
const CampoSchema = z.object({ etiqueta: z.string(), obligatorio: z.boolean() })

export type CampoPlantilla = { etiqueta: string; obligatorio: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string }

export type Caso = { solicitud: Solicitud; campos: CampoPlantilla[]; soportes: string[]; plantilla: string; errorPlantilla?: string }

/** Carga y valida los archivos de un caso. Nunca lanza. */
export function cargarCaso(dir: string): Resultado<Caso> {
  const raw = leerJson(join(dir, "solicitud.json"), "solicitud.json")
  if (!raw.ok) return raw
  const sol = SolicitudSchema.safeParse(raw.data)
  if (!sol.success) {
    const formato = (raw.data as { formato?: unknown })?.formato
    if (formato && !["xlsx", "pdf", "portal"].includes(String(formato))) return fallo(`Formato no soportado: "${String(formato)}". Formatos válidos: xlsx, pdf, portal.`)
    return fallo("solicitud.json no tiene la estructura esperada.")
  }
  const sop = leerJson(join(dir, "soportes-exigidos.json"), "soportes-exigidos.json")
  const soportes = sop.ok && Array.isArray(sop.data) ? sop.data.filter((x): x is string => typeof x === "string") : []
  const celdas = join(dir, "plantilla-celdas.json")
  const usarCeldas = sol.data.formato === "xlsx" || (!existsSync(join(dir, "plantilla-campos.json")) && existsSync(celdas))
  const archivo = usarCeldas ? "plantilla-celdas.json" : "plantilla-campos.json"
  const p = leerJson(join(dir, archivo), archivo)
  const base = { solicitud: sol.data, soportes, plantilla: archivo }
  // HU-5: una plantilla mala no detiene el caso; se reporta y se continúa con los soportes.
  if (!p.ok) return ok({ ...base, campos: [], errorPlantilla: `Plantilla no disponible: ${p.error}` })
  const esquema = usarCeldas ? z.array(CeldaSchema).min(1) : z.array(CampoSchema).min(1)
  const plantilla = esquema.safeParse(p.data)
  if (!plantilla.success) return ok({ ...base, campos: [], errorPlantilla: `La plantilla ${archivo} está corrupta o incompleta.` })
  const campos: CampoPlantilla[] = plantilla.data.map((c) => ({ obligatorio: true, ...c }))
  return ok({ ...base, campos })
}
