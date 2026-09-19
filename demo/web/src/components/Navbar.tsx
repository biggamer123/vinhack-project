import { useState } from "react";
import { login } from "../api/client";

export function Navbar({ onHome }: { onHome: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await login(email, password);
    setSignedIn(result.ok);
  };

  return (
    <nav>
      <button onClick={onHome}>Inkwell</button>
      {signedIn ? (
        <span>Signed in</span>
      ) : (
        <form onSubmit={handleLogin}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
          <button>Sign in</button>
        </form>
      )}
    </nav>
  );
}
