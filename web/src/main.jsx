import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyMode, getMode } from "./colorMode.js";
import "./theme.css";

function Root() {
  useEffect(() => {
    applyMode(getMode());
  }, []);

  return (
    <StrictMode>
      <App />
    </StrictMode>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
