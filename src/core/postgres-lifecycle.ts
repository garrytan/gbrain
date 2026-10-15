export async function closePostgresPool(pool:{end:(options:{timeout:number})=>Promise<unknown>}):Promise<void>{
  await pool.end({timeout:5});
}
