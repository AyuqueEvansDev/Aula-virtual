# 🎓 EduAula — Sistema Web Educativo (Secundaria)

Plataforma estilo Moodle para **Computación e Informática** y **Matemática**.
Simple, moderna, responsive y enfocada solo en gestión de actividades y entregas.

## 🚀 Cómo usar

1. Abre `index.html` en tu navegador (doble clic, o con Live Server).
2. Ingresa como:
   - **Docente** → botón "Entrar como Docente" (prof.carlos@colegio.edu)
   - **Estudiante** → botón "Entrar como Estudiante" (ana.quispe@colegio.edu)
3. Navega con el menú lateral (en celular usa ☰).

> No requiere servidor ni instalación. Los datos se guardan en `localStorage`.

## 👩‍🏫 Flujo DOCENTE
Login → Dashboard (totales, próximas a vencer, recientes, +Crear) → Mis cursos → Crear actividad (con vista previa) → Publicar → Entregas (tabla + filtros + buscador + descargar) → Detalle de entrega.

## 🧑‍🎓 Flujo ESTUDIANTE
Login → Dashboard (pendientes, próximas, entregadas, vencidas) → Mis cursos → Ver actividad (descripción, instrucciones, material, fechas, contador "Faltan X días") → Arrastrar/soltar archivo → Enviar → Confirmación ✓.

## 📺 Pantallas incluidas (16)
1. Inicio de sesión 2. Dashboard docente 3. Dashboard estudiante 4. Mis cursos
5. Curso Computación 6. Curso Matemática 7. Lista actividades 8. Crear actividad
9. Editar actividad 10. Vista actividad estudiante 11. Subir trabajo (drag&drop)
12. Confirmación de entrega 13. Entregas docente 14. Detalle entrega
15. Perfil 16. Configuración básica (+ Estudiantes).

## ⏰ Control de fechas
- Antes del límite → ✓ Entregado a tiempo (🟢/🔵).
- < 3 días → 🟡 Próximo a vencer + contador.
- Después del límite → 🔴 Vencido / ⚠️ Fuera de plazo, bloquea envío salvo `Aceptar tardías`.

## 📁 Archivos
- `index.html` — estructura + login + shell.
- `styles.css` — diseño responsive (sidebar → hamburger en móvil).
- `app.js` — SPA, datos demo, CRUD, entregas, filtros.

Para restablecer la demo: Configuración → ♻ Restablecer demo (o borra `eduaula_v1` del localStorage).
