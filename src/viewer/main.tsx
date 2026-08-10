import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from './App'
import './styles.css'
import "pdfjs-dist/web/pdf_viewer.css";

const container = document.getElementById('root')
if (!container) throw new Error('#root not found in index.html')

const root = createRoot(container)

root.render(
    <StrictMode>
        <App />
    </StrictMode>
)