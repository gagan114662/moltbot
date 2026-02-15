import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design/global.css";
import { Surface } from "./Surface";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Surface />
  </StrictMode>,
);
