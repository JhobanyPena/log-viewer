# Blob Log Tailer

Extensión para Google Chrome que mejora la visualización de archivos `.log` servidos directamente desde Azure Blob (u orígenes similares).

## Qué hace
- **Tail**: muestra siempre el final del archivo (opción *Seguir al final*).
- **Auto‑refresh**: recarga automáticamente cada N segundos (configurable y persistente).
- **Filtro**: campo de búsqueda que **no se borra** al actualizar (puedes usar texto o `/regex/flags`).
- **Resaltado**: colorea líneas por contenido. Incluye una regla de ejemplo para `ig_strategy: Ejecución de estrategia` y puedes añadir más en **Opciones**.
- **Eficiencia**: intenta usar peticiones HTTP **Range** para leer solo lo nuevo (si el servidor lo permite). Si no, hace GET completo con `no-store` para evitar caché.

## Instalación (modo desarrollador)
1. Descarga estos archivos a una carpeta, por ejemplo `blob-log-tailer/`.
2. Abre **chrome://extensions**.
3. Activa **Developer mode** (arriba a la derecha).
4. Click en **Load unpacked** y selecciona la carpeta.
5. Abre tu log, p. ej. `https://xxxxx.blob.core.windows.net/logs/QA_US500_2025-09-02.log`.

> Si no ves el visor, comprueba que la URL **termina en `.log`**. El script solo se activa en esos casos.

## Uso rápido
- Barra superior:
  - **Actualización (s)**: intervalo de auto‑refresh.
  - **Cola (KB)**: cuánto del final del archivo cargar al inicio / tras rotaciones.
  - **Seguir al final**: si está activo, el visor hace *auto‑scroll* al fondo tras cada actualización.
  - **Solo coincidencias**: si lo activas, solo verás las líneas que coinciden con el filtro.
  - **Filtro**: texto simple o regex (`/.../i`). Se mantiene entre actualizaciones.
  - **Pausar/Reanudar**: detiene o reanuda la recarga automática.
  - **Opciones**: abre la página para gestionar reglas de resaltado y valores por defecto.

## Notas técnicas
- **HEAD + Range**: si el servidor devuelve `Content-Length` y soporta `Range`, la extensión pide solo bytes nuevos (`bytes=last-`). Si el log se rota o acorta, vuelve a cargar la **cola** (últimos KB).
- **Sin HEAD/Range**: cae con gracia a **GET completo** con `cache-control: no-store`.
- **Filtrado**: texto simple -> `includes()` (case-insensitive). Regex -> escribe `/patrón/flags`.
- **Resaltado**: cada regla genera una clase CSS; puedes ajustar colores.

## Seguridad y permisos
- **host_permissions** incluye `https://*.blob.core.windows.net/*` para que el `content_script` pueda leer y volver a pedir el mismo `.log`.
- No se envían datos fuera del navegador; todo el procesamiento ocurre localmente.

## Personalización de patrones
Ejemplo para resaltar líneas de *Ejecución de estrategia* (ya incluida):
```json
{
  "name": "Ejecución de estrategia",
  "pattern": "ig_strategy: Ejecución de estrategia",
  "flags": "i",
  "className": "hl-ejecucion",
  "bgColor": "#fff1a8",
  "textColor": "#111111"
}
```

Puedes añadir más reglas desde **Opciones**.
