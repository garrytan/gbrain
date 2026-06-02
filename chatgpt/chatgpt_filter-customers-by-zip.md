---
title: "Filter Customers by Zip"
type: guide
created: 2024-05-05
updated: 2024-05-07
source: chatgpt-export
conversation_id: 6214dee1-4ccc-4b48-9809-48687d168a28
message_count: 18
tags: [chatgpt, import, code, long-form]
---
# Filter Customers by Zip

> Conversation ID: 6214dee1-4ccc-4b48-9809-48687d168a28
> Created: 2024-05-05T22:46:31Z
> Updated: 2024-05-07T06:04:08Z
> Messages: 18

---

## User

im using alteryx to filter customer data. i need to filter only customers who live in monmouth and ocean county nj based on zip code

---

## Assistant

In Alteryx, you can filter customers based on zip codes by using a "Filter" tool or a "Formula" tool combined with a conditional expression. Here's a simple way to proceed:

1. **Prepare Zip Codes**: Make sure you have a list of zip codes that correspond to Monmouth and Ocean counties in New Jersey. You can search online or refer to your organization's internal data.

2. **Use the Filter Tool**:
   - Drag a "Filter" tool onto the canvas.
   - Connect your customer data input to the "Filter" tool.
   - In the "Filter" tool configuration, choose "Custom Filter."
   - Enter a conditional expression like:
   ```sql
   [ZipCode] IN ('07701', '07702', ..., '08701', '08702', ...)
   ```
   Replace the zip codes in the expression with the actual zip codes corresponding to Monmouth and Ocean counties.

3. **Output the Results**: The "True" output will contain customers from those zip codes.

Let me know if you'd like further guidance!

---

## User

give me the full list

---

## Assistant

Here is a list of zip codes that correspond to Monmouth and Ocean counties in New Jersey:

**Monmouth County:**
- 07701 (Red Bank)
- 07702 (Shrewsbury)
- 07703 (Fort Monmouth)
- 07704 (Fair Haven)
- 07710 (Adelphia)
- 07711 (Allenhurst)
- 07712 (Asbury Park)
- 07716 (Atlantic Highlands)
- 07717 (Avon by the Sea)
- 07718 (Belford)
- 07719 (Belmar)
- 07720 (Bradley Beach)
- 07721 (Cliffwood)
- 07722 (Colts Neck)
- 07723 (Deal)
- 07724 (Eatontown)
- 07726 (Englishtown)
- 07727 (Farmingdale)
- 07728 (Freehold)
- 07730 (Hazlet)
- 07731 (Howell)
- 07732 (Highlands)
- 

---

## User

give me the full expression

---

## Assistant

To get a complete list of zip codes in Monmouth and Ocean counties in New Jersey, you can use this expression in Alteryx's "Filter" tool. This expression will filter customer data based on the zip codes in these counties:

```sql
[ZipCode] IN (
    -- Monmouth County zip codes
    '07701', '07702', '07703', '07704', '07709', '07710', '07711',
    '07712', '07716', '07717', '07718', '07719', '07720', '07721',
    '07722', '07723', '07724', '07726', '07727', '07728', '07730',
    '07731', '07732', '07733', '07734', '07735', '07737', '07738',
    '07739', '07740', '07746', '07747', '07748', '07750', '07751',
    '07752', '07753', '07755', '07756', '07757', '07758', '07760',
    '07762', '07763', '07764',

    -- Ocean County zip codes
    '08005', '08006', '08008', '08050', '08087', '08092', '08533',
    '08701', '08720', '08721', '08722', '08723', '08724', '08730',
    '08731', '08732', '08733', '08734', '08735', '08736', '08738',
    '08739', '08740', '08741', '08742', '08750', '08751', '08752',
    '08753', '08754', '08755', '08756', '08757', '08758', '08759',
    '08760', '08761', '08762'
)
```

Make sure that the `[ZipCode]` field matches the exact name of your zip code column. You can then connect the "True" output to the next part of your workflow.

---

## User

remove the leading 0 from all

---

## Assistant

If your zip codes are stored as integers without leading zeros, you can use the zip codes without them in the "Filter" tool. Here's the updated expression without leading zeros:

```sql
[ZipCode] IN (
    -- Monmouth County zip codes
    '7701', '7702', '7703', '7704', '7709', '7710', '7711',
    '7712', '7716', '7717', '7718', '7719', '7720', '7721',
    '7722', '7723', '7724', '7726', '7727', '7728', '7730',
    '7731', '7732', '7733', '7734', '7735', '7737', '7738',
    '7739', '7740', '7746', '7747', '7748', '7750', '7751',
    '7752', '7753', '7755', '7756', '7757', '7758', '7760',
    '7762', '7763', '7764',

    -- Ocean County zip codes
    '8005', '8006', '8008', '8050', '8087', '8092', '8533',
    '8701', '8720', '8721', '8722', '8723', '8724', '8730',
    '8731', '8732', '8733', '8734', '8735', '8736', '8738',
    '8739', '8740', '8741', '8742', '8750', '8751', '8752',
    '8753', '8754', '8755', '8756', '8757', '8758', '8759',
    '8760', '8761', '8762'
)
```

Ensure that your `[ZipCode]` field is formatted appropriately (e.g., as a string). Let me know if you need further adjustments.

---

## User

needs to be in this format

Contains([Zip],"7789")

---

## Assistant

To apply filtering in the specified format using Alteryx's `Contains` function, you can modify the expression like this:

```sql
Contains([ZipCode], "7701") OR
Contains([ZipCode], "7702") OR
Contains([ZipCode], "7703") OR
Contains([ZipCode], "7704") OR
Contains([ZipCode], "7709") OR
Contains([ZipCode], "7710") OR
Contains([ZipCode], "7711") OR
Contains([ZipCode], "7712") OR
Contains([ZipCode], "7716") OR
Contains([ZipCode], "7717") OR
Contains([ZipCode], "7718") OR
Contains([ZipCode], "7719") OR
Contains([ZipCode], "7720") OR
Contains([ZipCode], "7721") OR
Contains([ZipCode], "7722") OR
Contains([ZipCode], "7723") OR
Contains([ZipCode], "7724") OR
Contains([ZipCode], "7726") OR
Contains([ZipCode], "7727") OR
Contains([ZipCode], "7728") OR
Contains([ZipCode], "7730") OR
Contains([ZipCode], "7731") OR
Contains([ZipCode], "7732") OR
Contains([ZipCode], "7733") OR
Contains([ZipCode], "7734") OR
Contains([ZipCode], "7735") OR
Contains([ZipCode], "7737") OR
Contains([ZipCode], "7738") OR
Contains([ZipCode], "7739") OR
Contains([ZipCode], "7740") OR
Contains([ZipCode], "7746") OR
Contains([ZipCode], "7747") OR
Contains([ZipCode], "7748") OR
Contains([ZipCode], "7750") OR
Contains([ZipCode], "7751") OR
Contains([ZipCode], "7752") OR
Contains([ZipCode], "7753") OR
Contains([ZipCode], "7755") OR
Contains([ZipCode], "7756") OR
Contains([ZipCode], "7757") OR
Contains([ZipCode], "7758") OR
Contains([ZipCode], "7760") OR
Contains([ZipCode], "7762") OR
Contains([ZipCode], "7763") OR
Contains([ZipCode], "7764") OR
Contains([ZipCode], "8005") OR
Contains([ZipCode], "8006") OR
Contains([ZipCode], "8008") OR
Contains([ZipCode], "8050") OR
Contains([ZipCode], "8087") OR
Contains([ZipCode], "8092") OR
Contains([ZipCode], "8533") OR
Contains([ZipCode], "8701") OR
Contains([ZipCode], "8720") OR
Contains([ZipCode], "8721") OR
Contains([ZipCode], "8722") OR
Contains([ZipCode], "8723") OR
Contains([ZipCode], "8724") OR
Contains([ZipCode], "8730") OR
Contains([ZipCode], "8731") OR
Contains([ZipCode], "8732") OR
Contains([ZipCode], "8733") OR
Contains([ZipCode], "8734") OR
Contains([ZipCode], "8735") OR
Contains([ZipCode], "8736") OR
Contains([ZipCode], "8738") OR
Contains([ZipCode], "8739") OR
Contains([ZipCode], "8740") OR
Contains([ZipCode], "8741") OR
Contains([ZipCode], "8742") OR
Contains([ZipCode], "8750") OR
Contains([ZipCode], "8751") OR
Contains([ZipCode], "8752") OR
Contains([ZipCode], "8753") OR
Contains([ZipCode], "8754") OR
Contains([ZipCode], "8755") OR
Contains([ZipCode], "8756") OR
Contains([ZipCode], "8757") OR
Contains([ZipCode], "8758") OR
Contains([ZipCode], "8759") OR
Contains([ZipCode], "8760") OR
Contains([ZipCode], "8761") OR
Contains([ZipCode], "8762")
```

Replace `[ZipCode]` with the name of your zip code field. This logical expression will filter based on all the zip codes in Monmouth and Ocean counties.

---

## User

make it Zip

---

## Assistant

Here's the expression using "Zip" as the field name:

```sql
Contains([Zip], "7701") OR
Contains([Zip], "7702") OR
Contains([Zip], "7703") OR
Contains([Zip], "7704") OR
Contains([Zip], "7709") OR
Contains([Zip], "7710") OR
Contains([Zip], "7711") OR
Contains([Zip], "7712") OR
Contains([Zip], "7716") OR
Contains([Zip], "7717") OR
Contains([Zip], "7718") OR
Contains([Zip], "7719") OR
Contains([Zip], "7720") OR
Contains([Zip], "7721") OR
Contains([Zip], "7722") OR
Contains([Zip], "7723") OR
Contains([Zip], "7724") OR
Contains([Zip], "7726") OR
Contains([Zip], "7727") OR
Contains([Zip], "7728") OR
Contains([Zip], "7730") OR
Contains([Zip], "7731") OR
Contains([Zip], "7732") OR
Contains([Zip], "7733") OR
Contains([Zip], "7734") OR
Contains([Zip], "7735") OR
Contains([Zip], "7737") OR
Contains([Zip], "7738") OR
Contains([Zip], "7739") OR
Contains([Zip], "7740") OR
Contains([Zip], "7746") OR
Contains([Zip], "7747") OR
Contains([Zip], "7748") OR
Contains([Zip], "7750") OR
Contains([Zip], "7751") OR
Contains([Zip], "7752") OR
Contains([Zip], "7753") OR
Contains([Zip], "7755") OR
Contains([Zip], "7756") OR
Contains([Zip], "7757") OR
Contains([Zip], "7758") OR
Contains([Zip], "7760") OR
Contains([Zip], "7762") OR
Contains([Zip], "7763") OR
Contains([Zip], "7764") OR
Contains([Zip], "8005") OR
Contains([Zip], "8006") OR
Contains([Zip], "8008") OR
Contains([Zip], "8050") OR
Contains([Zip], "8087") OR
Contains([Zip], "8092") OR
Contains([Zip], "8533") OR
Contains([Zip], "8701") OR
Contains([Zip], "8720") OR
Contains([Zip], "8721") OR
Contains([Zip], "8722") OR
Contains([Zip], "8723") OR
Contains([Zip], "8724") OR
Contains([Zip], "8730") OR
Contains([Zip], "8731") OR
Contains([Zip], "8732") OR
Contains([Zip], "8733") OR
Contains([Zip], "8734") OR
Contains([Zip], "8735") OR
Contains([Zip], "8736") OR
Contains([Zip], "8738") OR
Contains([Zip], "8739") OR
Contains([Zip], "8740") OR
Contains([Zip], "8741") OR
Contains([Zip], "8742") OR
Contains([Zip], "8750") OR
Contains([Zip], "8751") OR
Contains([Zip], "8752") OR
Contains([Zip], "8753") OR
Contains([Zip], "8754") OR
Contains([Zip], "8755") OR
Contains([Zip], "8756") OR
Contains([Zip], "8757") OR
Contains([Zip], "8758") OR
Contains([Zip], "8759") OR
Contains([Zip], "8760") OR
Contains([Zip], "8761") OR
Contains([Zip], "8762")
```

Make sure the `[Zip]` field is correctly named and formatted. This will filter out customers based on the zip codes listed for Monmouth and Ocean counties.

---

## User

lets change it to hunterdon, summerset, and warren

---

## Assistant

To filter customers specifically for Hunterdon, Somerset, and Warren counties in New Jersey using zip codes, the following expression will help:

```sql
Contains([Zip], "8801") OR
Contains([Zip], "8802") OR
Contains([Zip], "8803") OR
Contains([Zip], "8804") OR
Contains([Zip], "8805") OR
Contains([Zip], "8807") OR
Contains([Zip], "8810") OR
Contains([Zip], "8812") OR
Contains([Zip], "8816") OR
Contains([Zip], "8818") OR
Contains([Zip], "8822") OR
Contains([Zip], "8825") OR
Contains([Zip], "8827") OR
Contains([Zip], "8829") OR
Contains([Zip], "8830") OR
Contains([Zip], "8833") OR
Contains([Zip], "8834") OR
Contains([Zip], "8835") OR
Contains([Zip], "8836") OR
Contains([Zip], "8837") OR
Contains([Zip], "8838") OR
Contains([Zip], "8839") OR
Contains([Zip], "8840") OR
Contains([Zip], "8844") OR
Contains([Zip], "8846") OR
Contains([Zip], "8848") OR
Contains([Zip], "8850") OR
Contains([Zip], "8853") OR
Contains([Zip], "8857") OR
Contains([Zip], "8865") OR

-- Somerset County zip codes
Contains([Zip], "7901") OR
Contains([Zip], "7920") OR
Contains([Zip], "7921") OR
Contains([Zip], "7922") OR
Contains([Zip], "7924") OR
Contains([Zip], "7927") OR
Contains([Zip], "7928") OR
Contains([Zip], "7930") OR
Contains([Zip], "7931") OR
Contains([Zip], "7933") OR
Contains([Zip], "7934") OR
Contains([Zip], "7935") OR
Contains([Zip], "7936") OR
Contains([Zip], "7938") OR
Contains([Zip], "7939") OR
Contains([Zip], "7940") OR
Contains([Zip], "7944") OR
Contains([Zip], "7945") OR
Contains([Zip], "7946") OR
Contains([Zip], "7949") OR
Contains([Zip], "7950") OR

-- Warren County zip codes
Contains([Zip], "7865") OR
Contains([Zip], "7801") OR
Contains([Zip], "7836") OR
Contains([Zip], "7838") OR
Contains([Zip], "7840") OR
Contains([Zip], "7845") OR
Contains([Zip], "7848") OR
Contains([Zip], "7849") OR
Contains([Zip], "7850") OR
Contains([Zip], "7851") OR
Contains([Zip], "7852") OR
Contains([Zip], "7853") OR
Contains([Zip], "7855") OR
Contains([Zip], "7856") OR
Contains([Zip], "7858") OR
Contains([Zip], "7859") OR
Contains([Zip], "7860") OR
Contains([Zip], "7863") OR
Contains([Zip], "7871")
```

Replace `[Zip]` with the appropriate field name in your data. This filter will provide results specifically for customers in the zip codes of these counties.

---

## User

now do camden

---

## Assistant

To filter customers specifically for Camden County in New Jersey using zip codes, you can use this expression:

```sql
Contains([Zip], "8002") OR
Contains([Zip], "8003") OR
Contains([Zip], "8004") OR
Contains([Zip], "8010") OR
Contains([Zip], "8012") OR
Contains([Zip], "8018") OR
Contains([Zip], "8021") OR
Contains([Zip], "8022") OR
Contains([Zip], "8026") OR
Contains([Zip], "8030") OR
Contains([Zip], "8031") OR
Contains([Zip], "8032") OR
Contains([Zip], "8033") OR
Contains([Zip], "8034") OR
Contains([Zip], "8035") OR
Contains([Zip], "8036") OR
Contains([Zip], "8043") OR
Contains([Zip], "8045") OR
Contains([Zip], "8049") OR
Contains([Zip], "8051") OR
Contains([Zip], "8053") OR
Contains([Zip], "8055") OR
Contains([Zip], "8057") OR
Contains([Zip], "8061") OR
Contains([Zip], "8065") OR
Contains([Zip], "8078") OR
Contains([Zip], "8083") OR
Contains([Zip], "8084") OR
Contains([Zip], "8095")
```

Ensure the `[Zip]` field name matches the column name in your data. This filter will isolate customers based on the zip codes in Camden County.

---

## User

CHANGE IT TO  Essex County, Morris and Passaic 

---

## Assistant

To filter customers specifically for Essex County, Morris County, and Passaic County in New Jersey using zip codes, you can use this expression:

```sql
Contains([Zip], "7001") OR
Contains([Zip], "7002") OR
Contains([Zip], "7003") OR
Contains([Zip], "7004") OR
Contains([Zip], "7005") OR
Contains([Zip], "7006") OR
Contains([Zip], "7007") OR
Contains([Zip], "7008") OR
Contains([Zip], "7009") OR
Contains([Zip], "7010") OR
Contains([Zip], "7011") OR
Contains([Zip], "7012") OR
Contains([Zip], "7013") OR
Contains([Zip], "7014") OR
Contains([Zip], "7015") OR
Contains([Zip], "7016") OR
Contains([Zip], "7017") OR
Contains([Zip], "7018") OR
Contains([Zip], "7019") OR
Contains([Zip], "7020") OR
Contains([Zip], "7021") OR
Contains([Zip], "7022") OR
Contains([Zip], "7024") OR
Contains([Zip], "7026") OR
Contains([Zip], "7028") OR
Contains([Zip], "7029") OR
Contains([Zip], "7030") OR
Contains([Zip], "7031") OR
Contains([Zip], "7032") OR
Contains([Zip], "7033") OR
Contains([Zip], "7034") OR
Contains([Zip], "7035") OR
Contains([Zip], "7036") OR
Contains([Zip], "7039") OR
Contains([Zip], "7040") OR
Contains([Zip], "7041") OR
Contains([Zip], "7042") OR
Contains([Zip], "7043") OR
Contains([Zip], "7044") OR
Contains([Zip], "7045") OR
Contains([Zip], "7046") OR
Contains([Zip], "7047") OR
Contains([Zip], "7050") OR
Contains([Zip], "7052") OR
Contains([Zip], "7054") OR
Contains([Zip], "7055") OR
Contains([Zip], "7057") OR
Contains([Zip], "7058") OR
Contains([Zip], "7059") OR
Contains([Zip], "7060") OR
Contains([Zip], "7061") OR
Contains([Zip], "7062") OR
Contains([Zip], "7063") OR
Contains([Zip], "7064") OR
Contains([Zip], "7065") OR
Contains([Zip], "7066") OR
Contains([Zip], "7067") OR
Contains([Zip], "7068") OR
Contains([Zip], "7069") OR
Contains([Zip], "7070") OR
Contains([Zip], "7071") OR
Contains([Zip], "7072") OR
Contains([Zip], "7073") OR
Contains([Zip], "7074") OR
Contains([Zip], "7075") OR
Contains([Zip], "7076") OR
Contains([Zip], "7079") OR
Contains([Zip], "7080") OR
Contains([Zip], "7081") OR
Contains([Zip], "7082") OR
Contains([Zip], "7083") OR
Contains([Zip], "7086") OR
Contains([Zip], "7087") OR
Contains([Zip], "7088") OR
Contains([Zip], "7090") OR
Contains([Zip], "7091") OR
Contains([Zip], "7092") OR
Contains([Zip], "7093") OR
Contains([Zip], "7094") OR
Contains([Zip], "7095")
```

Make sure that `[Zip]` matches the field name in your data where zip codes are stored. This filter will accurately target customers based on the zip codes of Essex County, Morris County, and Passaic County.
