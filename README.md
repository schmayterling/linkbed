## linkbed

make a custom discord-styled site or discord embed with **real buttons**, images, and rich text for your website or links.

[try it](https://linkbed.me)

<a href="https://linkbed.me">
<img width="3046" height="1912" alt="CleanShot 2026-11-17 at 5 44 54 PM@2x" src="https://github.com/user-attachments/assets/550c4505-6126-4eb4-877d-0c372460f857" />
</a>

<a href="https://linkbed.me/schmayterling">
<img width="3046" height="1912" alt="CleanShot 2026-11-17 at 5 45 40 PM@2x" src="https://github.com/user-attachments/assets/f821e171-200f-4e81-ab4d-97a95b1642f4" />
</a>

## running locally

linkbed requires node 24 or newer.

```bash
git clone https://github.com/schmayterling/linkbed.git
cd linkbed
npm ci
cp .env.example .env
npm run dev
```

The server runs TypeScript directly with Node. `npm run build` compiles browser modules to JavaScript, and `npm run dev` watches both.

Before opening a pull request, run `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm test`.

## self-hosting

### easy way

the easiest way would be to fork this repo, import it on vercel, then supply these 3:

```bash
DATABASE_URL=https://your-database.example.com
DATABASE_AUTH_TOKEN=your-read-write-token
PUBLIC_ORIGIN=https://your-domain.com
```

then click on deploy.

to access the admin dashboard (which only runs on localhost), run locally with the vars pointed towards your db and go to `/admin`.

### the other way

you can probably figure this out if you have a reverse proxy set up already and have been deploying stuff to your own domains.

## license

this project is licensed under [mit](LICENSE) © 2026 schmayterling.
