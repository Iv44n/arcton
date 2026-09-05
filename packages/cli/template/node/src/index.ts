import { nodeAdapter } from "@arcton/adapter-node";
import { Arcton } from "@arcton/core";

const app = Arcton();

app.get("/", () => {
	return "Hello, Arcton!";
});

app.listen({ adapter: nodeAdapter });
