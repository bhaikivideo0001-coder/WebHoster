# WebHosting server

Zero dependencies (Node 18+). Admin UI `/` par, aur uploaded sites yahin host hoti hain.

## Railway deploy
1. Is folder ko GitHub repo me daalo -> Railway -> New Project -> Deploy from repo.
2. Service me **Volume** add karo, mount path `/data`.
3. Variable: `DATA_DIR=/data`
4. Settings -> Networking -> Generate Domain. Bas, app us URL par khul jayegi.

Share link format: `https://<your-railway-domain>/s/<site-name>/`

## Optional
- `BASE_DOMAIN=mysites.com` + wildcard DNS `*.mysites.com` -> free subdomains (`name.mysites.com`) bhi live honge.
- Custom domain: user ke DNS me CNAME -> aapka domain, aur Railway me wahi domain add karo.
- `FREE_DAYS` (30), `MAX_SITES_PER_USER` (10), `MAX_FILE_MB` (20), `MAX_SITE_MB` (100).

## Note
Path links (`/s/name/`) sandboxed chalte hain (security): site ka JS localStorage/cookies use nahi kar sakta. Subdomain/custom domain par normal chalta hai.
