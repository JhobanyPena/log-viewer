# Blob Log Tailer

Extensión de Chrome para visualizar cómodamente archivos `.log` servidos directamente (p. ej. desde **Azure Blob Storage**). Añade **tail**, **auto-refresh** configurable, **filtro persistente**, **resaltado por contenido**, y una página de **Opciones** integrada en la misma vista.

> Probado con URLs tipo: `https://xxxxx.blob.core.windows.net/logs/QA_US500_2025-09-02.log`

---

## Características

- **Tail**: muestra el final del archivo y, si activas *Seguir al final*, hace auto-scroll en cada actualización.
- **Auto-refresh** configurable (segundos), persistente entre sesiones.
- **Filtro de búsqueda** que **no se borra** al actualizar.
- **Navegación por coincidencias**: flechas **↑/↓** para ir a la coincidencia anterior/siguiente + contador **actual/total**.
- **Resaltado por contenido**: reglas configurables (texto o regex) con colores personalizados.
- **Opciones integradas** en un **tab** dentro del visor (no hay página aparte).
- **Eficiente**: usa `HEAD` y **HTTP Range** para pedir sólo lo nuevo cuando el servidor lo permite; si no, cae a `GET` completo con `cache-control: no-store`.

---

## Estructura del proyecto

- blob-log-tailer/
  - manifest.json
  - content.js
  - content.css
  - README.md

---

## Instalación (modo desarrollador)

1. Descarga o clona esta carpeta `blob-log-tailer/`.
2. Abre `chrome://extensions`.
3. Activa **Developer mode** (arriba a la derecha).
4. Haz clic en **Load unpacked** y selecciona la carpeta.
5. Abre tu `.log` en el navegador. El visor aparecerá automáticamente en páginas cuya URL **termine en `.log`** (también funciona con querystring, p. ej. `.log?sv=...`).

---

## Uso rápido

### Tabs
- **Visor**: lectura del log, búsqueda, auto-refresh, etc.
- **Opciones**: gestor de reglas de **resaltado por contenido**. Al **Guardar**, se aplican inmediatamente.

### Controles (Visor)
- **Actualización (s)**: intervalo de auto-refresh.
- **Cola (KB)**: tamaño del *tail* inicial y tras rotaciones (cuántos KB del final se cargan).
- **Seguir al final**: auto-scroll hacia el fondo tras cada actualización.
- **Solo coincidencias**: si está activo, sólo se muestran líneas que cumplen el filtro.
- **Filtro**: texto simple o `/regex/flags`.  
  - Texto simple → búsqueda **case-insensitive** (`includes`).
  - Regex → escribe `/patrón/flags`, p. ej. `/\[(ERROR|WARN)\]/i`.
- **Navegación de búsqueda**:
  - Botones **↑ / ↓** saltan entre coincidencias.
  - El contador muestra **posición / total** (la coincidencia activa se resalta con borde más marcado).
  - Al navegar se desactiva “Seguir al final” para no perder el foco del resultado.

### Resaltado por contenido (tab Opciones)
Cada regla tiene:
- **Nombre** (descriptivo, no afecta la lógica).
- **Patrón**: texto o **regex** (sin barras `/.../`).
- **Flags** (si regex): por ejemplo `i` (ignorar may/min).
- **CSS class** (opcional): útil si quieres estilos distintos por regla (p. ej. `hl-ejecucion`, `hl-error`).
- **Color de fondo** y **Color de texto**.

> **Tip:** si dejas **CSS class** vacío en varias reglas, compartirán el mismo estilo y la última guardada podría sobrescribir colores de las anteriores.

**Ejemplos de patrones:**
- Texto literal: `ig_strategy: Ejecución de estrategia`
- Regex de niveles: `\[(ERROR|WARN)\]` (flags: `i`)
- Regex por hora: `^\d{4}-\d{2}-\d{2} 20:15:` (flags: vacío)

---

## Notas técnicas

- **Detección de `.log`**: el visor sólo se activa si la URL termina en `.log` (con o sin querystring).
- **HEAD + Range**: si el servidor responde `Content-Length` y soporta `Range`, se solicitarán únicamente los bytes nuevos (`bytes=last-`).  
  Si el archivo se acorta (rotación), se recarga la **cola** (últimos *N* KB).
- **Fallback sin Range**: se usa `GET` completo con `cache-control: no-store`.
- **Persistencia**: ajustes y reglas se guardan en `chrome.storage.sync`.

---

## Permisos y privacidad

- `host_permissions`: `https://*.blob.core.windows.net/*` para poder leer el mismo `.log` desde el content script.
- **Todo** el procesamiento se hace **localmente** en tu navegador. No se envían datos a ningún servicio externo.

---

## Solución de problemas

- **No aparece el visor**: verifica que la URL **termine en `.log`**. Ejemplos válidos:  
  - `.../archivo.log`  
  - `.../archivo.log?sv=...`  
- **No “avanza” el tail**: el servidor podría no soportar `HEAD` o `Range`. Sube el valor de **Actualización (s)** o baja el **Cola (KB)** para reducir coste de red.
- **Muchos datos / lentitud**: aumenta **Cola (KB)** para cargar menos en la primera pasada y confirma que “Solo coincidencias” esté desactivado si quieres ver todo.
- **Colores no aplican como esperas**: asigna **CSS class** distinta por regla para aislar estilos.