import time
import yaml
import argparse
from optionality.apis import get_client, get_option_strategies_info, get_option_holdings_info, get_strike_table
from optionality.notification import notification_funcs, build_html_message
from optionality.datatype import OptionStrategiesConfig, OptionHoldingsConfig

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optionality Parameters")
    parser.add_argument("-t", "--task", help="Task type", choices=["strategy", "holdings"])
    parser.add_argument("-f", "--setting_file", help="Configuration file", type=str)
    args = parser.parse_args()
    
    client = get_client()
    try:
        t_s = time.time()
        with open(args.setting_file, "r") as f:
            settings = yaml.safe_load(f)
        
        if args.task == "strategy":
            settings = OptionStrategiesConfig(**settings)
            
            df_strikes = get_strike_table(settings)
        
            df_summary, dt_details, _ = get_option_strategies_info(
                client,df_strikes, settings
            )
            
            df_warning = None
        
        elif args.task == "holdings":
            settings = OptionHoldingsConfig(**settings)
            
            df_summary, dt_details, df_warning = get_option_holdings_info(
                client, settings
            )
            
        else:
            raise ValueError(f"task type is wrong: {args.task}")
            

        

        body_message = build_html_message(df_summary, dt_details, df_warning)
        # notification
        setting_noti = settings.model_dump()["notification"]
        for noti, noti_param in setting_noti.items():
            func = notification_funcs[noti]
            func(noti_param, body_message)
            
        print(f"Session closed. total time: {time.time() - t_s}")
    except Exception as err:
        raise err
    finally:
        client.close()