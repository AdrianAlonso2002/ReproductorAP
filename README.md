# Reproductor AP

Reproductor de musica privado en HTML, CSS y JavaScript, listo para subir a GitHub Pages.

## Como anadir canciones

1. Mete tus archivos en la carpeta `songs`.
2. Anade una portada por cancion en la misma carpeta.
3. Edita `tracks.js` y cambia o anade entradas:

```js
{
  title: "Nombre de la cancion",
  artist: "Artista",
  cover: "songs/mi-portada.jpg",
  src: "songs/mi-cancion.mp3",
  color: "#d8a7ff",
  nuevo: true,
  date: "2026-06-26",
  album: "Nombre del álbum",
  description: "Descripción larga de la canción.",
  lyrics: "Letra completa de la cancion."
}
```

Si `nuevo` esta en `true`, la cancion mostrara una etiqueta roja de Nuevo en el panel izquierdo.

La primera cancion es una demo generada por el navegador para que puedas probar el reproductor sin tener todavia musica real.
