import { runColuviDrill } from "../src/simulator/coluvi-drill.ts";

console.log(JSON.stringify(await runColuviDrill(Number(process.argv[2] ?? 30), Number(process.argv[3] ?? 20261004)), null, 2));
