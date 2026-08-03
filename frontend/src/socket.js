import { io } from "socket.io-client";

// Se connecte au même hôte que la page (fonctionne en prod derrière le
// serveur Express, et en dev grâce au proxy WebSocket configuré dans vite.config.js).
export const socket = io({
  path: "/socket.io",
});
