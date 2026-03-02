from fastapi import APIRouter

router = APIRouter(prefix="/api/v1")

@router.get("/health")
async def health():
    return {"status": "ok"}

@router.get("/items")
async def list_items():
    return []
