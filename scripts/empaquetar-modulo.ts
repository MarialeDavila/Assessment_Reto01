/**
 * Genera modulo/ a partir de las mismas fuentes que usa la aplicación (sin copias divergentes):
 * agent/prompt.md -> modulo/agent.md, src/knowledge/registro-proveedor.md -> modulo/skill/.../SKILL.md,
 * src/tools/proveedor.ts -> modulo/tools/proveedor.ts (reexportación).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const raiz = join(import.meta.dir, "..")
const leer = (r: string) => readFileSync(join(raiz, r), "utf8")

export function contenidoModulo(): Record<string, string> {
  return {
    "modulo/agent.md": `---\ndescription: Prepara el registro de Periferia como proveedor ante clientes (formulario, soportes y paquete para firma) sin firmar ni enviar.\nmode: primary\npermission:\n  edit: deny\n  bash: deny\n---\n\n${leer("agent/prompt.md")}`,
    "modulo/skill/registro-proveedor/SKILL.md": `---\nname: registro-proveedor\ndescription: Conocimiento del proceso de registro como proveedor de Periferia IT Group (formatos, estados de campo, reglas por país y soportes).\n---\n\n${leer("src/knowledge/registro-proveedor.md")}`,
    "modulo/tools/proveedor.ts": `// Generado por scripts/empaquetar-modulo.ts. Mismas herramientas que la aplicación, importables sin el servidor.\nexport * from "../../src/tools/proveedor"\n`,
  }
}

if (import.meta.main) {
  for (const [ruta, contenido] of Object.entries(contenidoModulo())) {
    mkdirSync(join(raiz, ruta, ".."), { recursive: true })
    writeFileSync(join(raiz, ruta), contenido)
    console.log(`Escrito ${ruta}`)
  }
}
