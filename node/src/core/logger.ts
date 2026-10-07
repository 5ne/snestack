import winston from "winston";

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${ts} [${level}] ${stack || message}${metaStr}`;
});

// Color only for a person at a terminal; cron logs and files must stay plain text.
const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const jsonLogs = process.env.LOG_FORMAT === "json";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: jsonLogs
    ? combine(errors({ stack: true }), timestamp(), json())
    : combine(
        errors({ stack: true }),
        timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        ...(useColor ? [colorize()] : []),
        logFormat
      ),
  // Every level goes to stderr so stdout carries only a command's real output
  // (JSON, a model write-up) and scripts can redirect the two independently.
  transports: [
    new winston.transports.Console({
      stderrLevels: ["error", "warn", "info", "http", "verbose", "debug", "silly"],
    }),
  ],
});

/** Create a child logger with a fixed label prefix. */
export function getLogger(name: string): winston.Logger {
  return logger.child({ label: name });
}
