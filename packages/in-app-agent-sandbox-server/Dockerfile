FROM node:24-alpine

RUN apk add --no-cache jq python3
RUN addgroup -S sandbox && adduser -S sandbox -G sandbox

WORKDIR /app

COPY package.json ./package.json
RUN node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); fs.writeFileSync("package.json", JSON.stringify({ name: pkg.name, private: true, type: pkg.type, dependencies: pkg.dependencies }, null, 2));' \
  && npm install --omit=dev

COPY --chown=sandbox:sandbox dist ./dist

RUN mkdir -p /workspace && chown -R sandbox:sandbox /app /workspace

EXPOSE 5000

USER sandbox

CMD ["node", "/app/dist/server.js"]
