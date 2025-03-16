

def save_as_local_file(setting: dict, body_message: str):
    with open(setting["file_path"], "w") as f:
        f.write(body_message)