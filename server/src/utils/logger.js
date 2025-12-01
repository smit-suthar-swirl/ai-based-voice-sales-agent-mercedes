import morgan from "morgan";

export const httpLogger = morgan("combined");

export function logInfo(...args) {
  console.log("[INFO]", ...args);
}

export function logError(...args) {
  console.error("[ERROR]", ...args);
}