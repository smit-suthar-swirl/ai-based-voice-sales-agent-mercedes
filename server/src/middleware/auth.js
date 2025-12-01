import jwt from "jsonwebtoken";
import "dotenv/config";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

export function httpAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log(authHeader);
  
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];
console.log(JWT_SECRET);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// For Socket.io
export function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Missing auth token"));
    }
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    next();
  } catch (err) {
    next(new Error("Invalid auth token"));
  }
}