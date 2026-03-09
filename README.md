# Blob Log Tailer

Portal web para visualizar archivos `.log` almacenados en Azure Blob Storage. Accesible desde cualquier dispositivo (desktop, tablet, móvil) sin necesidad de instalar extensiones.

## Características

* **Selector de archivos** — Lista automáticamente todos los `.log` del container, ordenados por fecha descendente (más recientes primero).
* **Auto-refresh** configurable (1, 5, 15, 30, 60 min) alineado al reloj, con GET condicional (ETag / Last-Modified).
* **Filtro de búsqueda** con texto plano o regex (`/patrón/i`), persistente entre actualizaciones.
* **Navegación entre coincidencias** con botones ↑/↓ y contador actual/total.
* **Resaltado por contenido** configurable con colores personalizados (panel Opciones).
* **Seguir al final (tail)** con auto-scroll tras cada actualización.
* **Solo coincidencias** para filtrar y mostrar únicamente líneas relevantes.
* **Pausar/Reanudar** el auto-refresh.
* **Historial de búsquedas** (últimas 10, persistido en localStorage).
* **Diseño responsive** optimizado para móviles, tablets y escritorio.

## Estructura de archivos

```text
/log-viewer/
  web/
    index.html       # Página principal
    app.css          # Estilos (responsive)
    app.js           # Lógica de la aplicación
  README.md
```

## Configuración

La conexión al Blob Storage se configura en la constante `CONFIG` al inicio de `web/app.js`:

```js
const CONFIG = {
  storageAccount: "stsp500prodeastus",
  container: "logs",
};
```

### Requisitos en Azure Blob Storage

* **Acceso público** a nivel de Container (permite listar y leer blobs sin autenticación).
* **CORS** configurado en el Storage Account para permitir requests desde el dominio de la Static Web App:
  - **Allowed origins**: URL de tu Static Web App (o `*` para desarrollo).
  - **Allowed methods**: `GET`.
  - **Allowed headers**: `x-ms-version, If-None-Match, If-Modified-Since`.
  - **Exposed headers**: `ETag, Last-Modified, Content-Length`.

## Despliegue

El sitio se despliega como una **Azure Static Web App** usando el CLI `swa` con deployment token apuntando al ambiente de **production**.

### Requisitos previos

* [Azure Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/) instalado:

  ```bash
  npm install -g @azure/static-web-apps-cli
  ```

* Un **deployment token** de tu Static Web App (disponible en Azure Portal → tu recurso → Manage deployment token).

### Deploy a producción

```bash
swa deploy ./web --deployment-token <DEPLOYMENT_TOKEN> --env production
```

Esto sube el contenido de la carpeta `web/` directamente al ambiente de producción de la Static Web App.

> **Tip**: Puedes almacenar el token en una variable de entorno para no exponerlo en el historial del terminal:
>
> ```bash
> export SWA_CLI_DEPLOYMENT_TOKEN=<DEPLOYMENT_TOKEN>
> swa deploy ./web --env production
> ```

## Uso rápido

### Panel Visor

* **Selector de archivo**: desplegable con todos los `.log` del container. Al seleccionar uno se carga automáticamente.
* **Actualización (min)**: intervalo de auto-refresh (persistente entre sesiones).
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
* Cada regla define: **patrón** (texto o `/regex/i`), **color de fondo** y **color de texto**.
* Al guardar, se aplican inmediatamente en el visor.

## Notas técnicas

* **GET condicional**: usa headers `If-None-Match` (ETag) e `If-Modified-Since` para evitar descargas innecesarias (respuesta 304).
* **API version**: el listado de blobs usa el header `x-ms-version: 2020-10-02` para soportar todos los tipos de blob (block, append, page).
* **Filtrado**:
  * Texto simple → búsqueda case-insensitive con `includes()`.
  * Regex → escribe `/patrón/flags`.
* **Resaltado**: cada regla genera una clase CSS dinámica con los colores configurados.
* **Persistencia**: configuraciones, reglas y historial se guardan en `localStorage` del navegador.
* Todo el procesamiento ocurre localmente en el navegador; no se envían datos a terceros.

## Ejemplo de regla de resaltado

| Patrón | Fondo | Texto |
|---|---|---|
| `Ejecución de estrategia` | `#fff1a8` | `#111` |
| `Stop Loss` | `#d95f73` | `#111` |
| `Opening` | `#5f7bce` | `#111` |
| `Take Profit` | `#7dbf78` | `#111` |