from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pymongo

app = FastAPI(title="Sample FastAPI App")

# Middleware
app.add_middleware(CORSMiddleware, allow_origins=["*"])

# Database dependency
def get_db():
    client = pymongo.MongoClient("mongodb://localhost:27017")
    return client.mydb

# Routes
@app.get("/users")
async def list_users(db=Depends(get_db)):
    return list(db.users.find())

@app.post("/users")
async def create_user(user: dict, db=Depends(get_db)):
    db.users.insert_one(user)
    return {"status": "created"}

@app.get("/users/{user_id}")
async def get_user(user_id: str, db=Depends(get_db)):
    user = db.users.find_one({"_id": user_id})
    if not user:
        raise HTTPException(status_code=404)
    return user

@app.delete("/users/{user_id}")
async def delete_user(user_id: str, db=Depends(get_db)):
    db.users.delete_one({"_id": user_id})
    return {"status": "deleted"}
