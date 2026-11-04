# SOLUCIÓN: Reto 01, agente "Registro como Proveedor"

Link de prueba: https://assessment-reto01.onrender.com

## 1. Problema en una frase

La analista administrativa transcribe a mano, en cada solicitud de un cliente, los mismos datos y soportes de Periferia para registrarla como proveedor; eso genera retrabajo, errores en datos sensibles y dependencia de una sola persona.

## 2. Arquitectura

```
Front (web/index.html) --HTTP--> Backend Hono (src/server.ts)
                                  ├─ Ciclo del agente: LangGraph createAgent (src/agent/agente.ts)
                                  │    ├─ System prompt: agent/prompt.md + src/knowledge/registro-proveedor.md
                                  │    └─ Adaptador LLM propio (src/llm/adapter.ts) → Gemini | simulado
                                  ├─ Herramientas zod (src/tools/proveedor.ts) ← únicas fuentes de valores
                                  ├─ Sesiones en memoria + out/sesiones/*.json
                                  └─ SQLite out/app.db (tareas, transacciones_finales, logs_tecnicos, metricas_modelo)
fixtures/ (solo lectura) ──► herramientas ──► out/<caso>/ (formulario, paquete/, log.jsonl, ENVIO-SIMULADO.md)
```

- **Comportamiento:** `agent/prompt.md`.
- **Conocimiento:** `src/knowledge/registro-proveedor.md` (proceso) y `src/knowledge/reglas.json` (identificador por país, etiquetas ambiguas, umbrales, nombres de soportes). Cambiar una regla no toca el servidor.
- **Ejecución:** `src/tools/` (sin dependencias de LangChain; `demo.ts` las importa directamente).

## 3. Ciclo del agente

- Se usa `createAgent` de LangChain v1 sobre LangGraph: modelo → llamadas a herramientas → modelo, hasta una respuesta sin llamadas.
- Las herramientas propias (`{ description, args, execute }`) se convierten a herramientas LangChain en `src/agent/herramientas-langchain.ts`. LangChain valida los argumentos con el esquema zod y devuelve el error al modelo; además se revalida antes de ejecutar.
- **Tope de iteraciones (CA1):** `recursionLimit = 2 × MAX_ITERACIONES + 1`. Si se alcanza, se captura `GraphRecursionError` y se responde con lo realizado y lo pendiente.
- **Tope de costo:** tokens acumulados por sesión (`MAX_TOKENS_SESION`), límite de mensajes por IP por minuto y timeout al proveedor (`AbortSignal.timeout`).
- **Confirmación humana (CA3, RN4), en dos capas:**
  1. El prompt obliga a cerrar el turno con una pregunta y a no llamar `proveedor_simular_envio` por iniciativa propia.
  2. El servidor marca `pendienteConfirmacion` cuando se arma el paquete. En el siguiente turno solo pasa `confirmacionHumana = true` a las herramientas si el mensaje del usuario es una afirmación explícita (sin negación). `simular_envio` exige `confirmado: true` **y** esa marca del servidor; el modelo no puede saltarse la regla.
- **Trazabilidad (CA4, RN5):** cada llamada se muestra en el chat (nombre, argumentos, resumen y resultado) y queda en `out/log.jsonl` y `out/<caso>/log.jsonl`.
- **Errores (CA5):** timeout, cuota o credencial inválida se traducen a mensajes claros; la sesión no se pierde.
- **No inventar valores (CA2):** `generar_formulario` recalcula el mapeo desde el maestro y nunca usa valores enviados por el modelo.

## 4. Elección del modelo

- **Proveedor y modelo:** Google Gemini, `gemini-3.8-flash` (configurable con `GEMINI_MODEL`). Es el modelo Flash estable más reciente en la documentación de Google (consultada el 2026-11-04), tiene buen manejo de herramientas, baja latencia y nivel gratuito para la prueba.
- **Seguridad:** `safetySettings` en `BLOCK_LOW_AND_ABOVE` para acoso, odio, contenido sexual y contenido peligroso; `temperature: 0`.
- **Precio vigente (nivel estándar, por millón de tokens):** USD 0,75 de entrada y USD 3,75 de salida hasta el 31-12-2026; desde el 01-01-2027, USD 1,50 y USD 7,50.
- **Costo estimado por caso:** unas 5 llamadas al modelo con unos 25.000 tokens de entrada acumulados y unos 3.000 de salida → aproximadamente USD 0,03 por caso (USD 0,06 desde 2027). Con 12 casos al mes: cerca de USD 0,36 al mes (USD 0,72 desde 2027). Es una estimación; el costo real queda en `metricas_modelo` y en `GET /api/metricas`.
- Cambiar de proveedor implica agregar una clase que implemente `AdaptadorLLM` (`src/llm/`) y registrarla en `src/llm/index.ts`; el ciclo no cambia.

## 5. Diseño del portal web (sección 7.4)

- **Estrategia:** navegador controlado (Playwright) en modo asistido, operado por el agente en un entorno aislado, con selectores por etiqueta accesible y no por posición. Se descarta RPA de pantalla por fragilidad, y una extensión de navegador queda como alternativa cuando el cliente exija el navegador de la analista.
- **Límites:** CAPTCHA y MFA siempre los resuelve la persona; ante cambios de layout el agente se detiene y entrega `valores-portal.md`. No se reintenta en bucle.
- **Credenciales:** nunca en el repositorio, el prompt ni los logs. Viven en un gestor de secretos (por ejemplo Azure Key Vault o 1Password) o las teclea la analista directamente en la ventana del navegador; el agente nunca las ve. Los logs enmascaran cualquier campo de tipo contraseña.
- **Reparto:** el agente navega hasta el formulario y llena los campos con valores de las herramientas. La persona ingresa las credenciales, resuelve CAPTCHA/MFA, revisa la vista previa y hace clic en "Enviar". El agente toma captura como evidencia y la agrega al paquete.
- **Estado actual:** el caso `pa-logistica-istmo` devuelve `formato no soportado` y genera `out/pa-logistica-istmo/valores-portal.md` con los valores listos para copiar.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| LangChain v1 + LangGraph para el ciclo | Ciclo propio en un `while` | Ciclo probado, tope por `recursionLimit` y camino de evolución a grafos y multiagente; se mantiene un adaptador propio para no acoplar el resto del código. |
| Herramientas deterministas, sin LLM dentro | Pedir al modelo que mapee campos | Determinismo, trazabilidad y cero valores inventados; el modelo solo orquesta y resume. |
| Mapeo por glosario + similitud de palabras (Dice) con umbral 0.8 | Embeddings | Suficiente para los fixtures, explicable y sin costo; los umbrales están en `reglas.json`. |
| PDF generado con pdfkit | Rellenar un AcroForm | El PRD lo acepta y no se recibió un PDF real del cliente. |
| Confirmación validada en el servidor | Confiar solo en el prompt | Un prompt puede fallar; la regla RN4 no debe depender del modelo. |
| SQLite (bun:sqlite) para métricas y tareas | Sin base de datos o un servicio externo | Embebido, sin dependencias, útil para observabilidad; es opcional y su fallo no detiene la conversación. |
| Front HTML plano servido por el backend | React | Un solo proceso y un solo comando; menos piezas que desplegar. |

## 7. Supuestos

- "Fecha de ejecución" es la fecha del sistema al correr; se puede fijar con `FECHA_EJECUCION`. Con la fecha real (noviembre de 2026) la Cámara de Comercio (vigencia 2026-09-30) ya está vencida, por eso ningún caso queda `listo_para_firma`. Con `FECHA_EJECUCION=2026-09-02`, `co-industrias-delta` queda listo.
- Las plantillas Excel no traen columna `obligatorio`; se asumen obligatorios todos sus campos.
- Para el formato portal se usa `plantilla-campos.json` del caso como lista de campos.
- "Correo electrónico" se mapea a `contacto_comercial.email`, según el glosario entregado.
- Un campo `requiere_confirmacion` se escribe en el formulario con el valor propuesto y se marca en el PDF y en `reporte-faltantes.md`; no bloquea la firma.
- Un envío simulado se permite aunque el paquete esté bloqueado, pero `ENVIO-SIMULADO.md` registra los bloqueos vigentes como advertencia.
- Soportes emitidos en Colombia para clientes extranjeros se reportan como observación.

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Lectura real de correo (Graph/IMAP) y parseo de adjuntos reales. |
| HU-2 Mapear campos | Hecho | Glosario administrado por negocio y aprendizaje de sinónimos aprobados. |
| HU-3 Formulario xlsx (P0) | Hecho | Escribir sobre el archivo real del cliente conservando su formato. |
| HU-3 Formulario pdf (P1) | Hecho (PDF generado) | Rellenar AcroForms reales. |
| HU-3 Portal (P2) | Hecho según alcance (valores-portal.md) | Automatización asistida descrita en la sección 5. |
| HU-4 Paquete para firma | Hecho | Integración con firma electrónica y SharePoint. |
| HU-5 Manejo de errores | Hecho | Alertas y monitoreo centralizado. |
| Bonus módulo reutilizable | Hecho (`modulo/`, generado de las mismas fuentes y verificado por prueba) | Publicarlo como paquete versionado. |

## 9. Uso de IA

> Sección a completar y revisar por la candidata.

- **Claude (Claude Code):** apoyo en el diseño de la arquitectura, generación del código base de herramientas, ciclo, front, pruebas y borrador de esta documentación. Todo el código fue revisado y se puede explicar línea por línea.
- **Descartado de lo propuesto:** (completar) por ejemplo, un ciclo propio sin framework se reemplazó por LangGraph por decisión de arquitectura; MCP y multiagente se dejaron como evolución futura para no sobredimensionar el reto.

## 10. Riesgos en producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo inventa un valor plausible | Valores solo desde herramientas; el formulario se genera desde el maestro, no desde la salida del modelo. |
| Fuga de datos bancarios | RN2 en código (borrador sin datos bancarios, probado) y en el prompt; logs sin valores. |
| Envío sin autorización | Confirmación validada en servidor además del prompt. |
| Inyección de instrucciones en correos de clientes | El prompt ordena ignorar instrucciones en datos; las herramientas no ejecutan comandos ni acceden fuera de `fixtures/` y `out/`. |
| Gasto descontrolado de la clave | Topes de iteraciones, tokens por sesión, mensajes por minuto y clave de acceso opcional. |
| Maestro desactualizado o soportes vencidos | Dueño del dato definido; alertas de vencimiento previas usando `vigencia_hasta`. |
| Disco efímero en Render free | Para producción: almacenamiento persistente (disco de Render, Blob Storage) y base de datos administrada. |
| Cambio o retiro del modelo | Modelo configurable por variable y adaptador desacoplado. |

## Evolución futura

- **LangGraph con nodos explícitos** (leer → mapear → generar → paquete → interrupción humana) usando `interrupt` y checkpointer persistente.
- **MCP:** exponer `src/tools/proveedor.ts` como servidor MCP para usarlo desde otras plataformas de agentes.
- **Multiagente:** un agente de intake de correo, uno de documentos y uno de portales, coordinados por un supervisor, cuando el volumen y la variedad lo justifiquen.
