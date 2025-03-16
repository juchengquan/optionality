from pydantic import BaseModel, EmailStr
from typing import List, Literal

class GmailConfig(BaseModel):
    user: EmailStr
    password: str
    subject: str
    from_address: EmailStr 
    to_address: List[EmailStr]

class FileConfig(BaseModel):
    file_path: str

class NotificationConfig(BaseModel):
    gmail: GmailConfig
    file: FileConfig