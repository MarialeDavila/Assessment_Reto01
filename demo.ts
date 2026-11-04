/**
 * Verificación sin modelo: ejecuta las herramientas sobre todos los casos de fixtures/reto-01/casos/.
 * Uso: bun install && bun run demo.ts   (no requiere clave de ningún proveedor)
 */
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { herramientas, type Ctx } from "./src/tools/proveedor"

const directorio = import.meta.dir
rmSync(join(directorio, "out"), { recursive: true, force: true })

type R = { ok: boolean; data?: Record<string, unknown>; error?: string }
const parse = (s: string) => JSON.parse(s) as R

async function procesar(caso: string): Promise<void> {
  const ctx: Ctx = { directory: directorio, sessionId: "demo" }
  console.log(`\n=== ${caso} ===`)
  const sol = parse(await herramientas.leer_solicitud.execute({ caso }, ctx))
  if (!sol.ok) return void console.log(`  Error: ${sol.error}`)
  const d = sol.data as { pais: string; cliente: string; formato: string; campos: { etiqueta: string }[]; soportes: string[] }
  console.log(`  Cliente: ${d.cliente} (${d.pais}) | formato: ${d.formato} | campos: ${d.campos.length} | soportes exigidos: ${d.soportes.join(", ")}`)
  const map = parse(await herramientas.mapear_campos.execute({ caso, campos: d.campos.map((c) => c.etiqueta) }, ctx))
  if (map.ok) {
    const m = map.data as { llenos: unknown[]; faltantes: { etiqueta: string }[]; requiere_confirmacion: { etiqueta: string; nota?: string }[] }
    console.log(`  Mapeo: ${m.llenos.length} llenos, ${m.faltantes.length} faltantes, ${m.requiere_confirmacion.length} por confirmar`)
    if (m.faltantes.length) console.log(`    Faltantes: ${m.faltantes.map((f) => f.etiqueta).join(", ")}`)
    for (const r of m.requiere_confirmacion) console.log(`    Por confirmar: ${r.etiqueta} -> ${r.nota ?? ""}`)
  }
  const gen = parse(await herramientas.generar_formulario.execute({ caso }, ctx))
  console.log(gen.ok ? `  Formulario: ${gen.data?.ruta}${gen.data?.soportado === false ? " (formato no soportado: portal)" : ""}` : `  Formulario: ${gen.error}`)
  const paq = parse(await herramientas.armar_paquete.execute({ caso }, ctx))
  if (paq.ok) {
    const p = paq.data as { ruta: string; listo_para_firma: boolean; checklist: { bloqueos: string[] } }
    console.log(`  Paquete: ${p.ruta} | listo_para_firma: ${p.listo_para_firma}`)
    for (const b of p.checklist.bloqueos) console.log(`    Bloqueo: ${b}`)
  } else console.log(`  Paquete: ${paq.error}`)
  const sinConf = parse(await herramientas.simular_envio.execute({ caso, confirmado: false }, ctx))
  console.log(`  Envío sin confirmación: ${sinConf.ok ? "ERROR: no debió proceder" : sinConf.error}`)
}

const casos = readdirSync(join(directorio, "fixtures", "reto-01", "casos")).sort()
for (const caso of casos) await procesar(caso)

console.log("\n=== Manejo de errores ===")
const ctx: Ctx = { directory: directorio, sessionId: "demo" }
console.log(`  Caso inexistente: ${parse(await herramientas.leer_solicitud.execute({ caso: "caso-inexistente" }, ctx)).error}`)
console.log(`  Nombre inválido: ${parse(await herramientas.leer_solicitud.execute({ caso: "../etc" }, ctx)).error}`)
const env = parse(await herramientas.simular_envio.execute({ caso: "ec-corp-andina", confirmado: true }, ctx))
console.log(`  Envío confirmado (ec-corp-andina): ${env.ok ? env.data?.ruta : env.error}`)
console.log("\nFecha de ejecución usada para vigencias: " + (process.env.FECHA_EJECUCION ?? new Date().toISOString().slice(0, 10)))
