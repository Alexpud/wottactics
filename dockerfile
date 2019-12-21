FROM node

WORKDIR /app

COPY . /app

RUN npm install

USER node

EXPOSE 3000

CMD [ "node", "app.js" ]