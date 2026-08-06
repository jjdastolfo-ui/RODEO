# RODEO — plataforma de gestión ganadera y financiera

Un solo login. N organizaciones. Cada una con su sistema **GANADERO** y **FINANCIERO**.

## Qué hace esta versión (v1.0.0)

- `usuarios` / `organizaciones` / `miembros` con roles **ADMIN / OPERADOR / LECTURA**
- Login con hash scrypt (sin dependencias externas) + token HMAC firmado
- **Gateway**: `/api/gan/*` y `/api/fin/*` proxean a los backends que ya están corriendo,
  inyectando el `campo` / `empresa` que corresponde según la organización del token.
  Los sistemas actuales siguen funcionando igual, sin tocar una línea.
- **Chat único**: `/api/chat` rutea el mensaje a ganadería o finanzas por intención.
- **Cotizaciones**: US$/kg de novillo y TC local por esquema (AR / UY).
- **Auditoría**: todo lo que se escribe queda registrado con usuario, org e IP.
- Panel `/admin` para crear organizaciones y usuarios (superadmin).

## Deploy en Railway

1. Repo nuevo `rodeo`, subir estos archivos (sin `node_modules`).
2. Railway → New Project → Deploy from GitHub.
3. **Volumen persistente** montado en `/data`.
4. Variables:

| Variable | Valor |
|---|---|
| `DB_DIR` | `/data` |
| `JWT_SECRET` | string largo aleatorio (obligatorio) |
| `ADMIN_EMAIL` | jjdastolfo@gmail.com |
| `ADMIN_PASS` | tu clave inicial (si no la ponés, queda `amakaik2026` y pide cambiarla) |


5. Node queda pinneado en **20.x** por `engines` (Node 22 rompe el SDK).

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | login |
| `/app` | el sistema (selector de org + tabs Ganadero/Financiero + chat) |
| `/admin` | alta de organizaciones y usuarios |
| `/salud` | health check |

## Organizaciones cargadas

| Slug | Nombre | Razón social | Esquema | Campo ganadero | Empresa financiera |
|---|---|---|---|---|---|
| `cabana-amakaik` | Cabaña Amakaik | Videla | AR | `angus_la_posta` | LA POSTA |
| `angus-del-este` | Angus del Este | IMPROLUX | UY | `angus_del_este` | LA AMISTAD |
| `las-tranqueras` | Las Tranqueras | Amakaik SRL | UY | `las_tranqueras` | LAS TRANQUERAS |

## Pendiente en el backend ganadero (1 línea)

En `CAMPOS.angus_la_posta` cambiar `nombre: "Angus la Posta"` → `nombre: "Cabaña Amakaik"`.
La clave `angus_la_posta` **no se toca** (es el nombre del archivo .db y del ruteo de WhatsApp).

## Siguiente fase

- Bot único: un webhook que resuelve org por número `To` y usuario por `From`.
- Valuación en kg de carne en todos los reportes.
- Provisioning real: crear una org nueva que genere sus dos bases vacías sin depender
  de los deploys actuales (ahí deja de ser "mis 3 campos" y pasa a ser producto vendible).
