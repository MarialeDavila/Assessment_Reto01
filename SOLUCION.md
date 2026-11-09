# SOLUCIÓN · Reto 01: agente "Registro como Proveedor"

**Link de prueba:** https://assessment-reto01.onrender.com (plan gratuito de Render: la primera visita tras un periodo de inactividad puede tardar entre 30 y 60 segundos)
**Repositorio:** https://github.com/MarialeDavila/Assessment_Reto01

---

## 1. Problema en una frase

El área administrativa transcribe a mano, en cada solicitud de un cliente, los mismos datos y soportes de Periferia para registrarse como proveedor. Esto genera retrabajo, riesgo de error en datos sensibles (NIT, cuenta bancaria) y dependencia de una sola persona.

**A quién le duele:** a la analista administrativa, que pierde tiempo en tareas repetitivas, y al negocio, porque cada día de retraso en el registro retrasa la facturación.

**Qué entrega la solución:** un agente que lee la solicitud, llena el formulario con los datos oficiales, arma el paquete para firma y señala qué falta. La firma y el envío siguen siendo decisiones humanas.

---

## 2. Arquitectura

La solución separa tres responsabilidades, para que un cambio en las reglas de negocio no obligue a modificar el sistema:

| Capa | Qué contiene | Dónde vive |
|---|---|---|
| **Comportamiento** | Cómo debe actuar el agente y sus límites (guardrails) | `agent/prompt.md` |
| **Conocimiento** | Proceso de registro y reglas por país | `src/knowledge/` |
| **Ejecución** | Herramientas que leen, cruzan datos y generan documentos | `src/tools/` |

```
Usuaria (chat web)
      │
      ▼
Servidor (Bun + Hono, desplegado en Render con Docker)
      ├─ Agente experto (LangChain + LangGraph)  ──►  Modelo Gemini (vía adaptador propio)
      ├─ Herramientas deterministas (única fuente de datos)
      └─ Base local SQLite: tareas, transacciones, logs técnicos y métricas por modelo
      │
      ├─ Lee:      fixtures/ (solicitudes, maestro de datos, soportes)
      └─ Escribe:  out/<caso>/ (formulario, paquete para firma, registro de actividad)
```

**Principio de diseño:** el modelo de IA orquesta y redacta; los datos y los documentos los produce código determinista. Así el agente no puede inventar un valor, y el mismo código se puede verificar sin modelo con `demo.ts`.

---

## 3. Ciclo del agente

- **Motor:** LangChain v1 sobre LangGraph. El agente decide qué herramienta usar, la ejecuta, revisa el resultado y repite hasta tener una respuesta.
- **Eficiencia:** una herramienta de un solo paso (`proveedor_procesar_caso`) ejecuta lectura, mapeo, formulario y paquete. Así un caso completo usa unas 2 llamadas al modelo en lugar de 5, lo que reduce costo, tiempo y riesgo de superar los límites de uso. Las herramientas individuales del contrato siguen disponibles.
- **Tope de iteraciones:** 25 por turno, configurable. Si se alcanza, el agente responde con lo realizado y lo pendiente, sin perder la sesión.
- **Control de costo:** tope de tokens por sesión, límite de mensajes por minuto y tiempo máximo de 90 segundos por turno.
- **Límite de uso del proveedor:** si Gemini rechaza por exceso de solicitudes (error 429), el agente espera el tiempo que indica el proveedor, o una espera creciente, y reintenta hasta 3 veces. Si persiste, cambia a un modelo de respaldo más liviano (`gemini-3.1-flash-lite`, configurable). Si la cuota diaria está agotada, salta los reintentos. Como último recurso, responde en un modo determinista sin IA, claramente etiquetado, que ejecuta las mismas herramientas y redacta el resumen a partir de sus resultados. Así la demo no depende de la cuota gratuita.
- **Confirmación humana, en dos capas:**
  1. El agente cierra el turno con una pregunta explícita antes de cualquier envío.
  2. El servidor valida que la usuaria haya confirmado en el mensaje inmediatamente anterior. Aunque el modelo fallara, el envío no procede sin esa confirmación.
- **Trazabilidad:** cada acción del agente se muestra en el chat y queda registrada en `out/log.jsonl`, `out/<caso>/log.jsonl`; el estado de cada caso queda además en la base SQLite.
- **Errores:** las fallas del modelo o de una herramienta se muestran en lenguaje claro y la conversación continúa.

---

## 4. Elección del modelo

| Criterio | Decisión |
|---|---|
| **Proveedor y modelo** | Google Gemini, `gemini-3.8-flash`. Se puede cambiar con la variable `GEMINI_MODEL`. |
| **Por qué** | Buen manejo de herramientas, baja latencia, nivel gratuito y filtros de seguridad configurables. |
| **Seguridad** | Filtros en el nivel más estricto (`BLOCK_LOW_AND_ABOVE`) para acoso, odio, contenido sexual y contenido peligroso; temperatura 0. |
| **Costo por caso (estimado)** | Cerca de US$0,01 (unos 8.000 tokens de entrada y 1.500 de salida en 2 llamadas, al precio de US$0,75 y US$3,75 por millón). |
| **Costo mensual con 12 casos** | Cerca de US$0,15. Desde enero de 2027, cuando el precio se duplica, cerca de US$0,30. |
| **Medición real** | Cada turno de conversación registra tokens, latencia y costo estimado en la tabla `metricas_modelo` (consultable en `/api/metricas`). |

**Alternativas evaluadas:**

| Opción | Resultado |
|---|---|
| Claude Haiku 5.5 (Anthropic) | Más barato (cerca de US$0,07 al mes), pero sin filtros de seguridad configurables. Queda como respaldo. |
| Groq | Gratuito, pero su límite de 8.000 tokens por minuto es insuficiente para un agente con varias herramientas. |
| OpenRouter (modelos gratuitos) | Límite de 50 solicitudes al día y llamadas a herramientas poco estables. |
| Hugging Face | Las cuentas gratuitas no reciben créditos de inferencia. |

Como el costo es mínimo con cualquier opción, el criterio decisivo fue la seguridad. El adaptador propio permite cambiar de proveedor sin modificar el agente.

---

## 5. Diseño para portales web (sección 7.4)

| Tema | Propuesta |
|---|---|
| **Estrategia** | Navegador controlado por el agente (Playwright) en modo asistido. Se descarta el RPA de pantalla por ser frágil ante cambios de diseño. |
| **Límites** | El CAPTCHA y la autenticación de dos factores siempre los resuelve una persona. Si el portal cambia, el agente se detiene y entrega los valores listos para copiar. |
| **Credenciales** | Nunca en el repositorio, el prompt ni los logs. Se guardan en un gestor de secretos o las digita la analista directamente; el agente nunca las ve. |
| **Qué hace el agente** | Navega hasta el formulario, llena los campos con datos validados y toma evidencia. |
| **Qué hace la persona** | Ingresa las credenciales, revisa la vista previa y hace clic en "Enviar". |
| **Estado actual** | El caso de Panamá responde "formato no soportado" y genera `valores-portal.md` con los valores listos para copiar. |

---

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Agente con LangChain + LangGraph | Ciclo programado a mano | Motor probado, control de iteraciones y camino natural hacia flujos más complejos. |
| Herramientas deterministas | Que el modelo llene los campos | Exactitud, trazabilidad y cero datos inventados. |
| Un agente experto | Varios agentes coordinados | Un agente especializado es más confiable y económico para un proceso acotado. |
| Confirmación validada en el servidor | Confiar solo en el prompt | Las acciones externas no deben depender del comportamiento del modelo. |
| SQLite local | Base de datos externa | Sin costo ni servicios adicionales; suficiente para métricas y registro de tareas. |
| Front en HTML servido por el mismo servidor | Aplicación React separada | Un solo despliegue y menos puntos de falla en el plazo del reto. |
| Gemini | Otros proveedores | Filtros de seguridad configurables con costo mínimo. |

---

## 7. Supuestos

- La "fecha de ejecución" es la fecha del sistema (se puede fijar con `FECHA_EJECUCION`). Con la fecha real de noviembre de 2026, el certificado de Cámara de Comercio está vencido; por eso **ningún caso queda listo para firma**, que es el resultado correcto según las reglas.
- En las plantillas Excel se asume que todos los campos son obligatorios.
- Un campo que requiere confirmación se llena con el valor propuesto y se marca para revisión; no bloquea la firma.
- Los soportes emitidos en Colombia para clientes de otros países se reportan como observación.
- Los datos del reto son ficticios, por lo que el nivel gratuito de Gemini es aceptable para la prueba.

---

## 8. Cobertura

| Historia de usuario | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Conexión real al correo y lectura de adjuntos. |
| HU-2 Mapear campos al maestro | Hecho | Glosario administrado por el área de negocio. |
| HU-3 Formulario Excel | Hecho | Escribir sobre el archivo original del cliente. |
| HU-3 Formulario PDF | Hecho (PDF generado) | Rellenar formularios PDF originales. |
| HU-3 Portal web | Hecho según alcance | Automatización asistida descrita en la sección 5. |
| HU-4 Paquete para firma | Hecho | Integración con firma electrónica y repositorio documental. |
| HU-5 Manejo de errores | Hecho | Monitoreo y alertas centralizadas. |
| Bonus: módulo reutilizable | Hecho (`modulo/`) | Publicarlo como paquete versionado. |

**Verificación:** `demo.ts` procesa los 4 casos sin modelo, pasan 21 pruebas automáticas y la aplicación está desplegada en Render.

---

## 9. Uso de IA

| Asistente | Para qué se usó |
|---|---|
| **Claude (Claude Code en un proyecto de Claude)** | Planeación del reto y apoyo en las decisiones de arquitectura; comparación verificada de proveedores de modelos, costos y plataformas de despliegue; generación del código de herramientas, agente, servidor, front y pruebas; y borrador de la documentación. |

**Cómo se trabajó:** se separó un hilo de planeación y decisiones de un hilo de construcción. Ninguna decisión se ejecutó sin aprobación, y el código se verificó con `demo.ts`, pruebas automáticas y el despliegue.

**Qué se descartó de lo propuesto y por qué:**

- **Ciclo del agente programado a mano:** se reemplazó por LangGraph, por decisión de arquitectura.
- **MCP, React y arquitectura multiagente:** se dejaron como evolución futura para cumplir el plazo sin sobredimensionar el reto.
- **Hugging Face, Groq y OpenRouter como proveedores:** se descartaron por costo o por límites de uso insuficientes.
- **Compartir claves por el chat:** se descartó; la clave del modelo se configura solo como variable de entorno.

---

## 10. Riesgos en producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo inventa un dato | Los valores salen solo de las herramientas; el formulario se genera desde el maestro. |
| Exposición de datos bancarios | Regla en el código y en el prompt: nunca se incluyen en el borrador de correo (verificado con una prueba automática); el registro de actividad (`log.jsonl`) guarda solo resúmenes, no valores. |
| Envío sin autorización | Confirmación validada en el servidor, además del prompt. |
| Instrucciones maliciosas dentro de un correo | El agente trata el contenido como datos; las herramientas no ejecutan comandos. |
| Gasto descontrolado | Topes de iteraciones, tokens, mensajes por minuto y tiempo de espera. |
| Datos maestros desactualizados | Definir un dueño del dato y alertas previas al vencimiento de soportes. |
| Pérdida de archivos en el plan gratuito de Render | En producción, almacenamiento persistente y base de datos administrada. |
| Cambio o retiro del modelo | Modelo configurable y adaptador desacoplado. |

---

## Evolución propuesta

1. **Flujo explícito en LangGraph** con pausa para aprobación humana y memoria persistente.
2. **Protocolo MCP** para que otras plataformas de agentes usen las mismas herramientas.
3. **Arquitectura multiagente** (correo, documentos y portales) cuando el volumen lo justifique, con modelos de distinto costo según la complejidad de cada tarea.
