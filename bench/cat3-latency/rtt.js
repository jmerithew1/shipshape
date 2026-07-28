const pg = require('C:/Users/merit/OneDrive/Desktop/shipshape/api/node_modules/pg');
const pool = new pg.Pool({ host:'127.0.0.1', port:5433, database:'ship_dev', user:'ship', password:'ship_dev_password', max:1 });
(async () => {
  const t = async (label, sql, n) => {
    for (let i=0;i<20;i++) await pool.query(sql);           // warm
    const a=[];
    for (let i=0;i<n;i++){ const s=process.hrtime.bigint(); await pool.query(sql); a.push(Number(process.hrtime.bigint()-s)/1e6); }
    a.sort((x,y)=>x-y);
    console.log(`${label.padEnd(28)} p50=${a[Math.floor(n*0.5)].toFixed(2)}ms p95=${a[Math.floor(n*0.95)].toFixed(2)}ms avg=${(a.reduce((s,v)=>s+v,0)/n).toFixed(2)}ms`);
  };
  await t('SELECT 1 (pure RTT)', 'SELECT 1', 200);
  await t('auth SELECT session+user', "SELECT s.id,s.user_id,u.is_super_admin FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id='x'", 200);
  await t('auth UPDATE sessions', "UPDATE sessions SET last_activity=NOW() WHERE id='nonexistent'", 200);
  await pool.end();
})();
