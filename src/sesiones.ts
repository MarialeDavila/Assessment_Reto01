import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Sesion } from "./agent/agente"

const ID_VALIDO = /^[A-Za-z0-9_-]{6,64}$/

/** Sesiones en memoria; el historial visible se copia en out/sesiones/<id>.json. */
export class Sesiones {
  private readonly mapa = new Map<string, Sesion>()
  constructor(private readonly directorio: string, private readonly maximo = 200) {}

  valido(id: string): boolean {
    return ID_VALIDO.test(id)
  }

  obtener(id: string): Sesion | undefined {
    return this.mapa.get(id)
  }

  obtenerOCrear(id: string): Sesion {
    const s = this.mapa.get(id)
    if (s) return s
    if (this.mapa.size >= this.maximo) {
      const masAntigua = this.mapa.keys().next().value
      if (masAntigua) this.mapa.delete(masAntigua)
    }
    const nueva: Sesion = { id, mensajes: [], historial: [], tokens: 0, pendienteConfirmacion: false }
    this.mapa.set(id, nueva)
    return nueva
  }

  guardar(s: Sesion): void {
    try {
      const dir = join(this.directorio, "out", "sesiones")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${s.id}.json`), JSON.stringify({ id: s.id, tokens: s.tokens, historial: s.historial }, null, 2))
    } catch {
      // La persistencia en archivo es opcional.
    }
  }
}
