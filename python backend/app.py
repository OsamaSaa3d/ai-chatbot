from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # or ["http://localhost:3000"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class QueryRequest(BaseModel):
    message: str

@app.post("/query")
async def query_endpoint(request: QueryRequest):
    print("responded:", request.message)
    return {
        "response": f"You said: {request.message}",
        "status": "ok",
        "mock": True
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
