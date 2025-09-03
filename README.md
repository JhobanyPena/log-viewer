# Blob Log Tailer (Chrome Extension)

Visor mejorado para archivos `.log` servidos desde Azure Blob (o cualquier URL similar). Añade:

* **Siempre mostrar el final (tail)**
* **Auto-refresh** configurable
* **Filtro de búsqueda** que **no se borra** al actualizar
* **Resaltado por contenido** configurable
* **Opciones integradas** en un tab dentro del visor
* **Navegación entre coincidencias** con botones ↑/↓ y contador actual/total

> Funciona sobre páginas que muestran directamente el `.log` (por ejemplo: `https://xxxxx.blob.core.windows.net/logs/QA_US500_2025-09-02.log`).

---

## Estructura de archivos

```text
/blob-log-tailer/
  manifest.json
  content.js
  content.css
  README.md
```

---

## Instalación (modo desarrollador)

1. Descarga estos archivos a una carpeta, por ejemplo `blob-log-tailer/`.
2. Abre **chrome://extensions**.
3. Activa **Developer mode** (arriba a la derecha).
4. Haz clic en **Load unpacked** y selecciona la carpeta.
5. Abre tu log, p. ej. `https://xxxxx.blob.core.windows.net/logs/QA_US500_2025-09-02.log`.

> Si no ves el visor, comprueba que la URL **termina en `.log`**. El script solo se activa en esos casos.

---

## Uso rápido

### Panel Visor

* **Actualización (s)**: intervalo de auto-refresh (persistente entre sesiones).
* **Seguir al final**: si está activo, el visor hace *auto-scroll* al fondo tras cada actualización.
* **Solo coincidencias**: si lo activas, solo verás las líneas que coinciden con el filtro.
* **Filtro**: texto simple o regex (`/.../i`). Se mantiene entre actualizaciones.
* **Navegación por coincidencias**:

  * Botones **↑ / ↓** recorren los resultados.
  * Contador muestra la coincidencia actual y el total.
  * La coincidencia activa se resalta con borde más marcado.
* **Pausar/Reanudar**: detiene o reanuda la recarga automática.

### Panel Opciones

* Gestiona las reglas de **resaltado por contenido**.
* Cada regla define: **nombre**, **patrón** (texto o regex), **flags**, **clase CSS** (opcional) y **colores**.
* Al guardar, se aplican inmediatamente en el visor.

---

## Notas técnicas

* **Recarga completa**: en cada intervalo se vuelve a descargar el archivo completo, con un parámetro de *cache-buster* y `cache: no-store` para evitar respuestas cacheadas.
* **Filtrado**:

  * Texto simple → búsqueda case-insensitive con `includes()`.
  * Regex → escribe `/patrón/flags`.
* **Resaltado**: cada regla genera una clase CSS; puedes personalizar colores.
* **Persistencia**: configuraciones y reglas se guardan en `chrome.storage.sync`.

---

## Seguridad y permisos

* **host\_permissions** incluye `https://*.blob.core.windows.net/*` para que el `content_script` pueda leer y volver a pedir el mismo `.log`.
* Todo el procesamiento ocurre localmente en el navegador; no se envían datos fuera.

---

## Ejemplo de regla de resaltado

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