/** Convierte las herramientas propias ({ description, args, execute }) en herramientas de LangChain. */
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"
import { herramientas } from "../tools/proveedor"
import type { Ctx } from "../tools/lib"

type Herramienta = { description: string; args: z.ZodRawShape; execute: (args: never, ctx: Ctx) => Promise<string> }

export function aLangChain(ctx: Ctx): StructuredToolInterface[] {
  return Object.entries(herramientas as Record<string, Herramienta>).map(([nombre, h]) => {
    const esquema = z.object(h.args)
    return tool(
      async (entrada: unknown) => {
        // El backend valida antes de ejecutar y devuelve el error al modelo si no cumple.
        const v = esquema.safeParse(entrada)
        if (!v.success) return JSON.stringify({ ok: false, error: `Argumentos inválidos: ${v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` })
        return h.execute(v.data as never, ctx)
      },
      { name: `proveedor_${nombre}`, description: h.description, schema: esquema },
    ) as StructuredToolInterface
  })
}
