## linkbed

make a custom discord-styled site or discord embed with **real buttons**, images, and rich text for your website or links.

[try it](https://linkbed.me)

<img width="3240" height="2176" alt="CleanShot 2026-11-17 at 3 20 36 PM@2x" src="https://github.com/user-attachments/assets/bbee4ef8-e69a-4392-a205-be6f3a767230" />

<img width="3240" height="2176" alt="CleanShot 2026-11-17 at 3 21 58 PM@2x" src="https://github.com/user-attachments/assets/5a9f331d-3996-4062-aeca-1e5837f140ff" />

<img width="1196" height="772" alt="CleanShot 2026-11-17 at 3 22 59 PM@2x" src="https://github.com/user-attachments/assets/cae6cb9e-7d3c-4911-88c5-a34a2ebe07d5" />


## running locally

linkbed requires node 24 or newer.

```bash
git clone https://github.com/schmayterling/linkbed.git
cd linkbed
npm ci
cp .env.example .env
npm run dev
```

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
