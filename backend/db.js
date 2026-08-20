import mysql from 'mysql2/promise';
import 'dotenv/config';

const connectionOptions = {
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || ''
};
const databaseName = process.env.DB_NAME || 'aharnish_pdf';
const pool = mysql.createPool({ ...connectionOptions, database: databaseName, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });

export async function initializeDatabase() {
  // Connecting without a selected database lets a new project initialize itself.
  const adminConnection = await mysql.createConnection(connectionOptions);
  await adminConnection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName.replace(/`/g, '``')}\``);
  await adminConnection.end();
  await pool.query(`CREATE TABLE IF NOT EXISTS visitor_logs (
    id INT AUTO_INCREMENT PRIMARY KEY, ip_address VARCHAR(64), user_agent TEXT,
    page_visited VARCHAR(255), visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS download_logs (
    id INT AUTO_INCREMENT PRIMARY KEY, visitor_id INT NULL, tool_used VARCHAR(100),
    original_file_name VARCHAR(255), file_size_kb DECIMAL(12,2),
    download_status VARCHAR(30) DEFAULT 'completed', downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_download_visitor FOREIGN KEY (visitor_id) REFERENCES visitor_logs(id) ON DELETE SET NULL
  )`);
}
export default pool;
