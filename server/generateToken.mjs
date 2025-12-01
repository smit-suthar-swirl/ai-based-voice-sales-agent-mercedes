// generateToken.mjs
import jwt from "jsonwebtoken";
import "dotenv/config";

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// You can adjust payload as you like
const payload = {
  userId: "test-user",
  orgId: "demo-org",
};

const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
console.log("JWT token:\n");
console.log(token);
