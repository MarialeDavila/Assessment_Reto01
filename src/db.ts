/** Registro local en SQLite (out/app.db): tareas, transacciones finales, logs técnicos y métricas del modelo. */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

export type Metrica = { sesion: string; proveedor: string; modelo: string; entrada: number; salida: number; latenciaMs: number; costoUsd: number; iteraciones: number }

export class Registro {
  private db: Database | undefined

  constructor(directorio: string) {
    try {
      mkdirSync(join(directorio, "out"), { recursive: true })
      this.db = new Database(join(directorio, "out", "app.db"), { create: true })
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tareas (id INTEGER PRIMARY KEY, sesion_id TEXT, caso TEXT, estado TEXT, creada TEXT, actualizada TEXT, UNIQUE(sesion_id, caso));
        CREATE TABLE IF NOT EXISTS transacciones_finales (id INTEGER PRIMARY KEY, ts TEXT, sesion_id TEXT, caso TEXT, ruta TEXT, listo_para_firma INTEGER);
        CREATE TABLE IF NOT EXISTS logs_tecnicos (id INTEGER PRIMARY KEY, ts TEXT, sesion_id TEXT, nivel TEXT, evento TEXT, detalle TEXT);
        CREATE TABLE IF NOT EXISTS metricas_modelo (id INTEGER PRIMARY KEY, ts TEXT, sesion_id TEXT, proveedor TEXT, modelo TEXT, tokens_entrada INTEGER, tokens_salida INTEGER, latencia_ms INTEGER, costo_usd REAL, iteraciones INTEGER);
      `)
    } catch (e) {
      console.warn("SQLite no disponible; se continúa sin registro en base de datos.", e instanceof Error ? e.message : "")
      this.db = undefined
    }
  }

  private run(sql: string, ...params: (string | number | null)[]): void {
    try {
      this.db?.query(sql).run(...params)
    } catch {
      // El registro nunca interrumpe la conversación.
    }
  }

  tarea(sesion: string, caso: string, estado: string): void {
    const ts = new Date().toISOString()
    this.run(`INSERT INTO tareas (sesion_id, caso, estado, creada, actualizada) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sesion_id, caso) DO UPDATE SET estado = excluded.estado, actualizada = excluded.actualizada`, sesion, caso, estado, ts, ts)
  }

  transaccion(sesion: string, caso: string, ruta: string, listo: boolean): void {
    this.run(`INSERT INTO transacciones_finales (ts, sesion_id, caso, ruta, listo_para_firma) VALUES (?, ?, ?, ?, ?)`, new Date().toISOString(), sesion, caso, ruta, listo ? 1 : 0)
  }

  log(sesion: string, nivel: "info" | "error", evento: string, detalle: string): void {
    this.run(`INSERT INTO logs_tecnicos (ts, sesion_id, nivel, evento, detalle) VALUES (?, ?, ?, ?, ?)`, new Date().toISOString(), sesion, nivel, evento, detalle.slice(0, 2000))
  }

  metrica(m: Metrica): void {
    this.run(`INSERT INTO metricas_modelo (ts, sesion_id, proveedor, modelo, tokens_entrada, tokens_salida, latencia_ms, costo_usd, iteraciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, new Date().toISOString(), m.sesion, m.proveedor, m.modelo, m.entrada, m.salida, m.latenciaMs, m.costoUsd, m.iteraciones)
  }

  resumenMetricas(): Record<string, unknown>[] {
    try {
      return (this.db?.query(`SELECT proveedor, modelo, COUNT(*) AS turnos, SUM(tokens_entrada) AS tokens_entrada, SUM(tokens_salida) AS tokens_salida, ROUND(AVG(latencia_ms)) AS latencia_promedio_ms, ROUND(SUM(costo_usd), 6) AS costo_usd FROM metricas_modelo GROUP BY proveedor, modelo`).all() as Record<string, unknown>[]) ?? []
    } catch {
      return []
    }
  }
}
