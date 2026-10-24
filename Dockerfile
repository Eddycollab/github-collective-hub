# Railway image: only the page (web/, without tests) and the server. No npm dependencies.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node server/app.mjs server/config.mjs server/index.mjs server/proxy.mjs server/session.mjs ./server/
COPY --chown=node:node web/ ./web/
RUN rm -rf ./web/tests
USER node
EXPOSE 8080
CMD ["node", "server/index.mjs"]
