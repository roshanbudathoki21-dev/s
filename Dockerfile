FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY uber-flow-discovery.js ./
COPY DISCOVERY-README.md ./

EXPOSE 3000

CMD ["node", "index.js"]
