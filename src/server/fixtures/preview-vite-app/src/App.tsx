import { useEffect, useState } from "react"
import { Link, Route, Routes } from "react-router-dom"
import markUrl from "./mark.svg"

const fixtureApiOrigin = import.meta.env.VITE_FIXTURE_API_ORIGIN as string

function Shell({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0)
  const [apiMessage, setApiMessage] = useState("loading")
  const [xhrMessage, setXhrMessage] = useState("loading")
  const [absoluteFetchMessage, setAbsoluteFetchMessage] = useState("loading")
  const [absoluteXhrMessage, setAbsoluteXhrMessage] = useState("loading")

  useEffect(() => {
    void fetch("/api/status")
      .then((response) => response.json())
      .then((payload: { message: string }) => setApiMessage(payload.message))

    const request = new XMLHttpRequest()
    request.open("GET", "/api/status")
    request.addEventListener("load", () => {
      const payload = JSON.parse(request.responseText) as { message: string }
      setXhrMessage(payload.message)
    })
    request.send()

    void fetch(`${fixtureApiOrigin}/api/status`)
      .then((response) => response.json())
      .then((payload: { message: string }) => setAbsoluteFetchMessage(payload.message))

    const absoluteRequest = new XMLHttpRequest()
    absoluteRequest.open("GET", `${fixtureApiOrigin}/api/status`)
    absoluteRequest.addEventListener("load", () => {
      const payload = JSON.parse(absoluteRequest.responseText) as { message: string }
      setAbsoluteXhrMessage(payload.message)
    })
    absoluteRequest.send()
  }, [])

  return (
    <main className="fixture-shell">
      <img src={markUrl} alt="Fixture mark" width="32" height="32" />
      <h1>Remote preview ready</h1>
      <p data-testid="business-literal">Business literal: {"/"}</p>
      <p data-testid="api-message">API: {apiMessage}</p>
      <p data-testid="xhr-message">XHR: {xhrMessage}</p>
      <p data-testid="absolute-fetch-message">Absolute fetch: {absoluteFetchMessage}</p>
      <p data-testid="absolute-xhr-message">Absolute XHR: {absoluteXhrMessage}</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Count: {count}
      </button>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/apartments">Apartments</Link>
        <Link to="/apartments/42">Apartment 42</Link>
      </nav>
      {children}
    </main>
  )
}

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<p>Home route</p>} />
        <Route path="/apartments" element={<p>Apartments route</p>} />
        <Route path="/apartments/:id" element={<p>Apartment detail route</p>} />
      </Routes>
    </Shell>
  )
}
