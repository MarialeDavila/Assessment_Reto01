# Conocimiento del proceso: registro como proveedor

## Origen de las solicitudes
Llegan por correo de clientes en Colombia (CO), Ecuador (EC), Perú (PE), Panamá (PA) y Honduras (HN). Recepción deposita cada caso en `fixtures/reto-01/casos/<caso>/` con `solicitud.json`, la plantilla y `soportes-exigidos.json`.

## Formatos de salida
- `xlsx`: plantilla Excel con hoja y celda por campo (`plantilla-celdas.json`). Se genera `out/<caso>/formulario.xlsx`.
- `pdf`: lista ordenada de campos (`plantilla-campos.json`). Se genera `out/<caso>/formulario.pdf`.
- `portal`: no se automatiza. Se genera `out/<caso>/valores-portal.md`; una persona ingresa credenciales y hace clic en "Enviar".

## Estados de un campo
- `lleno`: existe en el maestro; se indica la ruta del dato.
- `faltante`: no existe en el maestro. Nunca se inventa. No bloquea la firma, pero va en el checklist.
- `requiere_confirmacion`: etiqueta ambigua, mapeo con confianza menor a 0.8 o regla de país.

## Reglas de negocio
- RN1. Identificador tributario por país: CO NIT, EC RUC, PE RUC, PA RUC, HN RTN. Periferia solo tiene NIT colombiano: fuera de CO se llena con el NIT y se marca "identificador extranjero".
- RN2. Datos bancarios solo si la plantilla los pide. Nunca en el borrador de correo.
- RN3. Un soporte vencido (vigencia anterior a la fecha de ejecución) o ausente bloquea `listo_para_firma`.
- RN4. Ninguna acción externa sin confirmación explícita del usuario en el turno inmediatamente anterior. En este sistema "enviar" solo escribe `ENVIO-SIMULADO.md`.
- RN5. Toda ejecución queda en `out/<caso>/log.jsonl`.

## Soportes habituales
Cámara de Comercio (vigencia 30 días), RUT, certificación bancaria, parafiscales (mensual), estados financieros (anual), certificado de cumplimiento tributario, ISO 9001. Las reglas parametrizables están en `src/knowledge/reglas.json`.
