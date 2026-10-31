import type { BunRequest } from "bun";

const COOKIE = "domat_auth";

const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) throw new Error("PASSWORD env variable is not set, refusing to start");

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update("domat:" + value).digest("hex");
const TOKEN = hash(PASSWORD);

export function protect(name: string) {
    return (req: BunRequest) => {
        if (req.cookies.get(COOKIE) === TOKEN) {
            return new Response(Bun.file(`./dist/${name}`))
        } else {
            return Response.redirect("/middleware");
        }
    }
}

export async function login(req: BunRequest): Promise<Response> {
  const form = await req.formData();
  if (hash(form.get("password")) !== TOKEN) return Response.redirect("/middleware?wrong");

  req.cookies.set(COOKIE, TOKEN, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60,
    secure: req.headers.get("x-forwarded-proto") === "https",
  });
  return Response.redirect("/");
}
