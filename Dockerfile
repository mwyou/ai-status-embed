FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.mjs history.mjs gemini.mjs deepseek.mjs kimi.mjs index.html openai.html claude.html gemini.html deepseek.html kimi.html ./
USER node
ENV HOST=0.0.0.0 PORT=8099
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8099/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
