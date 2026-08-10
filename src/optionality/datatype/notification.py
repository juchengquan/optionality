from pydantic import BaseModel, EmailStr, ConfigDict


class GmailConfig(BaseModel):
    user: EmailStr
    password: str
    subject: str
    from_address: EmailStr
    to_address: list[EmailStr]


class FileConfig(BaseModel):
    file_path: str


class NotificationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    gmail: GmailConfig | None = None
    file: FileConfig | None = None
